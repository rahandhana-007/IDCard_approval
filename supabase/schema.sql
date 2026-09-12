-- =====================================================================
-- KartuSign — skema Supabase (Postgres + Auth + Row Level Security)
-- Jalankan SELURUH isi file ini di Supabase Dashboard → SQL Editor → Run.
--
-- Tabel:
--   profiles      : username + nama lengkap + role (user/manager) + status aktif, terhubung ke auth.users
--   signing_keys  : kunci tanda tangan (privat disimpan TERENKRIPSI frasa sandi)
--   requests      : antrean pengajuan kartu (user → manager) + hasil approval
--   heartbeat     : keep-alive anti-pause (free tier) — ditulis aplikasi/cron tiap ±3 hari
--   card_seq      : counter nomor kartu otomatis (PUR-tahun-bulan-NNNN) per bulan
--
-- Prasyarat: matikan "Confirm email" di
--   Authentication → Providers → Email → Confirm email = OFF
-- Akun pertama yang mendaftar lewat aplikasi otomatis menjadi manager.
-- =====================================================================

-- ---------- profiles ----------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text unique not null,
  full_name  text not null default '',      -- v2.3: nama lengkap (wajib saat pendaftaran)
  role       text not null default 'user' check (role in ('user','manager')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- v2.3 (aman dijalankan ulang): tambahkan kolom nama lengkap bila skema lama
alter table public.profiles add column if not exists full_name text not null default '';

alter table public.profiles enable row level security;

-- saat user baru signup di Supabase Auth, otomatis buat baris profil
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, full_name)
  values (new.id,
          coalesce(nullif(new.raw_user_meta_data->>'username',''), split_part(new.email, '@', 1)),
          coalesce(nullif(new.raw_user_meta_data->>'full_name',''), ''))
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- helper (security definer agar tidak terkena RLS rekursif)
create or replace function public.is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'manager' and active);
$$;

create or replace function public.has_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where role = 'manager' and active);
$$;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles
  for insert to authenticated with check (id = auth.uid());

-- bootstrap: akun pertama boleh menaikkan dirinya jadi manager bila belum ada manager
drop policy if exists profiles_promote_first on public.profiles;
create policy profiles_promote_first on public.profiles
  for update to authenticated
  using (id = auth.uid() and not public.has_manager())
  with check (id = auth.uid());

-- manager boleh mengubah role/status akun lain
drop policy if exists profiles_update_manager on public.profiles;
create policy profiles_update_manager on public.profiles
  for update to authenticated
  using (public.is_manager()) with check (true);

drop policy if exists profiles_delete_manager on public.profiles;
create policy profiles_delete_manager on public.profiles
  for delete to authenticated using (public.is_manager());

-- v2.3: tiap akun dapat mengubah NAMA LENGKAP-nya sendiri (hanya kolom full_name,
-- lewat security definer — tidak bisa dipakai menaikkan role sendiri)
create or replace function public.update_my_full_name(nama text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(length(trim(coalesce(nama,''))),0) < 2 then
    raise exception 'Nama lengkap minimal 2 karakter';
  end if;
  update public.profiles set full_name = trim(nama) where id = auth.uid();
end; $$;
revoke all on function public.update_my_full_name(text) from public;
grant execute on function public.update_my_full_name(text) to authenticated;

-- ---------- heartbeat (keep-alive anti-pause free tier) ----------
-- Supabase free tier mem-pause proyek bila tidak ada aktivitas API ±7 hari.
-- Aplikasi menulis baris id='app' (max tiap 3 hari); cron eksternal menulis id='cron'.
-- Sengaja boleh ditulis anonim: isinya cuma stempel waktu, tanpa data sensitif.
create table if not exists public.heartbeat (
  id        text primary key check (id in ('app','cron')),
  last_beat timestamptz not null default now(),
  note      text not null default ''
);

alter table public.heartbeat enable row level security;

drop policy if exists heartbeat_insert on public.heartbeat;
create policy heartbeat_insert on public.heartbeat
  for insert to anon, authenticated with check (true);

drop policy if exists heartbeat_update on public.heartbeat;
create policy heartbeat_update on public.heartbeat
  for update to anon, authenticated using (true) with check (true);

drop policy if exists heartbeat_select on public.heartbeat;
create policy heartbeat_select on public.heartbeat
  for select to anon, authenticated using (true);

-- ---------- card_seq (nomor kartu otomatis PUR-tahun-bulan-NNNN) ----------
-- Counter per periode bulan (zona Asia/Jakarta). Penomoran lewat RPC atomic
-- di bawah sehingga unik lintas pengguna walau diajukan bersamaan.
create table if not exists public.card_seq (
  period text primary key,               -- 'YYYY-MM'
  last_n integer not null default 0
);

alter table public.card_seq enable row level security;

drop policy if exists card_seq_select on public.card_seq;
create policy card_seq_select on public.card_seq
  for select to authenticated using (true);

-- tiap panggilan: increment counter bulan berjalan → kembalikan ID kartu baru
create or replace function public.next_card_id()
returns text language plpgsql security definer set search_path = public as $$
declare
  p text := to_char(now() at time zone 'Asia/Jakarta', 'YYYY-MM');
  n int;
begin
  insert into public.card_seq (period, last_n) values (p, 1)
    on conflict (period) do update set last_n = public.card_seq.last_n + 1
    returning last_n into n;
  return 'PUR-' || p || '-' || lpad(n::text, 4, '0');
end; $$;
revoke all on function public.next_card_id() from public;
grant execute on function public.next_card_id() to authenticated;

-- ---------- signing_keys ----------
create table if not exists public.signing_keys (
  key_id     text primary key,             -- 'ES256' / 'RS256'
  alg        text not null,
  kid        text not null,
  pubkey_pem text not null,
  priv_enc   text not null,                -- blob JSON: privat terenkripsi AES-GCM (frasa sandi) atau plain
  locked     boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.signing_keys enable row level security;

drop policy if exists keys_select on public.signing_keys;
create policy keys_select on public.signing_keys
  for select to authenticated using (true);

drop policy if exists keys_insert_manager on public.signing_keys;
create policy keys_insert_manager on public.signing_keys
  for insert to authenticated with check (public.is_manager());

drop policy if exists keys_update_manager on public.signing_keys;
create policy keys_update_manager on public.signing_keys
  for update to authenticated using (public.is_manager()) with check (public.is_manager());

drop policy if exists keys_delete_manager on public.signing_keys;
create policy keys_delete_manager on public.signing_keys
  for delete to authenticated using (public.is_manager());

-- ---------- requests ----------
create table if not exists public.requests (
  id          uuid primary key default gen_random_uuid(),
  created_by  uuid references auth.users(id),
  by_name     text not null default '',
  card_name   text not null default 'kartu.png',
  card_data   jsonb not null default '{}'::jsonb,   -- {cid,hld,apr,exp,rsn}
  image_b64   text not null default '',             -- byte gambar kartu (base64)
  image_mime  text not null default 'image/png',
  status      text not null default 'menunggu' check (status in ('menunggu','disetujui','ditolak')),
  note        text not null default '',
  payload     text not null default '',             -- isi QR setelah ditandatangani
  kid         text not null default '',
  signed_by   text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.requests enable row level security;

drop policy if exists req_insert on public.requests;
create policy req_insert on public.requests
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists req_select on public.requests;
create policy req_select on public.requests
  for select to authenticated using (created_by = auth.uid() or public.is_manager());

drop policy if exists req_update_manager on public.requests;
create policy req_update_manager on public.requests
  for update to authenticated using (public.is_manager()) with check (public.is_manager());

drop policy if exists req_delete on public.requests;
create policy req_delete on public.requests
  for delete to authenticated using (created_by = auth.uid() or public.is_manager());

create index if not exists requests_created_at_idx on public.requests (created_at desc);
create index if not exists requests_status_idx on public.requests (status);

-- updated_at otomatis
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

drop trigger if exists requests_set_updated_at on public.requests;
create trigger requests_set_updated_at
  before update on public.requests
  for each row execute function public.set_updated_at();

-- Selesai. Uji cepat di SQL Editor:
--   select * from public.profiles;
