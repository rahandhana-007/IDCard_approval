# KartuSign — Tanda Tangan Digital (QR) untuk Kartu

Aplikasi web **satu file HTML** untuk membubuhkan *digital signature* berupa **QR code** ke gambar kartu yang sudah siap, lalu mengunduh/mencetak kartu yang sudah disahkan — dengan **backend Supabase** (Auth + Postgres + Row Level Security) sehingga **akun, kunci, antrean pengajuan, dan riwayat tersinkron antar perangkat**.

Proses kriptografi (pembuatan kunci, hash, tanda tangan, QR, rendering) tetap berjalan **di browser** (Web Crypto API + Canvas); Supabase menyimpan akun/login, antrean pengajuan (gambar + data kartu), hasil approval, dan blob kunci privat **yang sudah terenkripsi frasa sandi**. Deploy sekali ke Netlify (atau hosting statis mana pun) → user mengajukan dari perangkat apa pun, manager menyetujui dari perangkat lain, petugas memverifikasi lewat halaman verifier publik.

---

## Alur kerja

```
[LOGIN via Supabase Auth: level 1 = user · level 2 = manager]
        │
        ▼  (user, dari perangkat mana pun)
[upload desain kartu + isi nama, ID kartu, masa berlaku, dll]
        │  Ajukan Approval  ──► tersimpan di database (tabel requests)
        ▼
[antrean manager — otomatis ter-update (polling)] ── Proses / Tolak(+catatan)
        │  (manager, dari perangkat mana pun)
        ▼
SHA-256( string kanonik(metadata) + byte gambar )  ──► ditandatangani kunci privat
        │                                              (ECDSA P-256 / RSA-2048)
        ▼
[QR code berisi metadata + hash + tanda tangan] ──► ditempel ke kartu
        │
        ▼
[status → disetujui + payload & tata letak tersimpan di server]
        │
        ▼  (kembali ke USER)
[USER membuka tab Pengajuan → "Unduh Kartu"]
   kartu dirender ulang di perangkat user, PERSIS dgn tata letak
   & tanda tangan basah manager → unduh PNG/JPG/QR · cetak
        │
        ▼
[petugas memverifikasi: tempel isi QR]  ✔ ASLI / ✖ TIDAK ASLI
```

### Role & login (2 level, Supabase Auth)

| Level | Akun | Akses |
|---|---|---|
| **1 — user** | dibuat manager (atau daftar sendiri) | Tab *Pengajuan Kartu* (upload kartu + isi data, **mengunduh kartu yang sudah disetujui**), *Verifikasi*, *Bantuan*. Tidak bisa menandatangani & tidak melihat kunci. |
| **2 — manager** | **akun pertama yang dibuat otomatis menjadi manager** | Tab *Approval & Tanda Tangan* (antrean, tanda tangan, unduh/cetak), *Kunci & Akun*, *Riwayat*, *Verifikasi*, *Bantuan*. |

- Login diverifikasi **Supabase Auth** (password di-hash bcrypt di server); sesi + refresh token disimpan di localStorage browser → tetap login antar-kunjungan, berlaku lintas perangkat.
- **Row Level Security (RLS)** di database: user hanya melihat pengajuannya sendiri; hanya manager yang bisa mengubah status, mengelola kunci & akun. Kebijakan ditegakkan di server, bukan cuma di UI.
- Manager dapat **menambah akun** (user/manager), **menaik-menurunkan level**, dan **menonaktifkan akun**; minimal satu manager aktif harus tersisa.
- Password sesi manager juga dipakai sebagai frasa sandi bawaan kunci privat (bila kolom frasa sandi kosong) dan **otomatis membuka kunci terenkripsi saat login di perangkat mana pun**. Ganti password → kunci di server otomatis dibungkus ulang dengan password baru.
- Antrean pengajuan & riwayat **tersinkron otomatis** (polling ±7 detik + tombol muat ulang).
- **Pembagian tugas**: manager menyetujui/menandatangani; **user yang mengunduh kartu hasil**. Saat approval, server menyimpan payload QR + **tata letak badge manager** (posisi/ukuran/rotasi/caption/watermark/ECL) + **gambar tanda tangan basah** (bila ada) — kartu dirender ulang di perangkat user **identik** dengan yang dilihat manager, tanpa user perlu akses kunci apa pun.
- File `KartuSign-Verifier.html` tetap **tanpa login & tanpa server** (mode verifier, kunci publik tertanam) agar petugas luar cukup menempel isi QR.

### Langkah pakai (versi singkat)

0. **Sekali saja**: siapkan proyek Supabase (lihat bagian *Setup Supabase* di bawah) → buka aplikasi → isi **Supabase URL + anon key** di panel *Hubungkan ke Supabase* → **Buat akun baru** (akun pertama otomatis jadi manager).
1. Buka URL aplikasi → **masuk** (user atau manager).
   - *(user)* ajukan kartu → tunggu status **disetujui** → klik **Unduh Kartu** di tabel *pengajuan saya* → simpan PNG/JPG/QR atau cetak.
2. Tab **Kunci & Akun** → pilih algoritma → isi frasa sandi (opsional, sangat disarankan) → **Buat kunci baru** (tersimpan terenkripsi di server).
   - Unduh **kunci publik (.pem)** dan sebarkan ke petugas verifikator.
   - Unduh **cadangan kunci privat terenkripsi** dan simpan di tempat aman.
3. Tab **Tanda Tangani Kartu** → klik area upload / tarik gambar kartu.
4. Isi data approval, atur posisi & ukuran QR (bisa digeser langsung di pratinjau).
5. Klik **Beri Tanda Tangan Digital** → **Unduh Kartu** atau **Cetak**.
6. Cek hasilnya di tab **Verifikasi Keaslian**: **tempel isi QR** → tekan *Periksa Keaslian Kartu* → **✓ KARTU INI ASLI** / **✗ KARTU TIDAK ASLI**. Tanpa kunci publik, tanpa upload gambar.

### Orientasi kartu (default: POTRET)

- Pilihan **Orientasi kartu** berada di blok *Tampilan tanda tangan (QR)*; **default = Potret/berdiri**.
- Saat *Potret*, checkbox **Putar tanda tangan 90°** otomatis aktif → blok QR + teks menjadi **strip vertikal di tepi kartu**, sehingga tidak memakan lebar kartu yang sempit. Pilih *Lanskap* untuk kembali mendatar (rotasi mati).
- Posisi (kanan/kiri-atas/bawah/bebas), ukuran, dan margin tetap bisa diatur; perhitungan jejak badge sudah memperhitungkan rotasi sehingga badge tidak pernah terpotong tepi kartu.
- `contoh-kartu.png` yang disertakan juga berformat potret (54 × 85,6 mm @300 dpi).

---

## Format payload QR

Payload berupa JSON ringkas (field opsional yang kosong dibuang agar QR tetap jarang/mudah dipindai):

```json
{
  "v": 2,
  "alg": "ES256",
  "kid": "d6a67cbf4c1b",
  "ts": 1767225600,
  "cid": "KTR-2026-000123",
  "hld": "BUDI SANTOSO, S.T.",
  "apr": "Kepala Divisi SDM",
  "exp": "2027-12-31",
  "rsn": "Kartu dinyatakan sah",
  "h": "<SHA-256 gambar, base64url, 43 char>",
  "s": "<tanda tangan, base64url, 86 char (ES256) / 342 char (RS256)>"
}
```

| Field | Arti |
|---|---|
| `v` | Versi format payload (saat ini `1`) |
| `alg` | `ES256` = ECDSA P-256/SHA-256 · `RS256` = RSASSA-PKCS1-v1_5 2048/SHA-256 |
| `kid` | Key ID = 12 hex pertama dari SHA-256(SPKI kunci publik). Opsional 6 hex ("Key ID ringkas") |
| `ts` | Waktu approval (Unix seconds, UTC) |
| `cid` | Nomor/ID kartu |
| `hld` | Nama pemegang kartu |
| `apr` | Pejabat yang mengesahkan |
| `exp` | Tanggal kedaluwarsa (`YYYY-MM-DD`, opsional) |
| `rsn` | Keterangan/alasan approval (opsional) |
| `h` | SHA-256 **byte gambar kartu asli**, base64url tanpa padding |
| `sh` | *(opsional, v3)* SHA-256 **file PNG tanda tangan basah**, base64url — mengikat tanda tangan visual ke payload |
| `ss` | *(opsional, v3)* tanda tangan ringkas (monokrom 96×40, 1-bit, deflate/raw, base64url) yang **tertanam di QR** — dapat direkonstruksi ulang oleh verifikator |
| `s` | Tanda tangan digital, base64url tanpa padding |

### String kanonik yang ditandatangani (skema v2)

```
v2: canonical = "KS2" | alg | kid | ts | cid | hld | apr | exp | rsn | h
v3: canonical = "KS3" | alg | kid | ts | cid | hld | apr | exp | rsn | h | sh | ss
digest  = SHA-256( UTF8(canonical) )
```

> `kid` yang dipakai adalah nilai **yang ada di payload** (6 atau 12 karakter). Field opsional yang tidak ada diisi string kosong.
> Karena hash gambar (`h`) ikut **di dalam** string kanonik, tanda tangan sudah mengikat gambar — maka verifikasi **tidak membutuhkan file gambar** sama sekali.

### Cara verifikasi (pseudocode) — cukup payload

```js
const obj   = JSON.parse(payloadQR);                    // hasil scan/tempel
const canon = ["KS2", obj.alg, obj.kid, String(obj.ts),
               obj.cid||"", obj.hld||"", obj.apr||"", obj.exp||"", obj.rsn||"", obj.h||""].join("|");
const digest = await crypto.subtle.digest("SHA-256", utf8(canon));
const ok = await crypto.subtle.verify(
   obj.alg === "ES256" ? {name:"ECDSA", hash:"SHA-256"} : {name:"RSASSA-PKCS1-v1_5"},
   publicKeyTerpercaya, base64urlToBytes(obj.s), digest);
// opsional (bila file gambar asli tersedia):
const hashCocok = base64url(await crypto.subtle.digest("SHA-256", bytes)) === obj.h;
const asli = ok && (hashCocok !== false);
```

### Sumber kunci terpercaya (tanpa tempel kunci)

Urutan pemeriksaan aplikasi:
1. **TRUST_STORE tertanam** — isi `KartuSign-Verifier.html` (kunci publik penerbit dibake-in saat unduh dari tab Kunci).
2. **Kunci penandatangan di perangkat itu** (IndexedDB/localStorage).
3. **Riwayat approval** di perangkat itu (tiap entri menyimpan kunci publik penerbit).
4. *(opsional lanjutan)* kunci publik manual PEM/JWK.

Kid payload dicocokkan dengan prefiks (kid ringkas 6 karakter = prefiks kid 12 karakter).
Bila tidak ada kunci yang cocok → hasil **"? ISSUER TIDAK DIKENAL"** (bukan asal dinyatakan asli).

### Aplikasi verifier untuk petugas

Di tab **Kunci & Keamanan** → **"Unduh Aplikasi Verifier (kunci tertanam)"**.
Menghasilkan `KartuSign-Verifier.html`: salinan aplikasi dengan kunci publik Anda di dalam `TRUST_STORE`,
membuka langsung tab Verifikasi (mode verifier). Petugas cukup: **tempel isi QR → Periksa → ✓ KARTU INI ASLI / ✗ KARTU TIDAK ASLI**.

---

## API JavaScript (untuk integrasi)

Objek global `window.KartuSign` tersedia agar aplikasi ini bisa dipanggil dari sistem lain atau diotomasi lewat konsol browser:

```js
await KartuSign.loadCard(fileOrBlobOrUrl);      // muat kartu
await KartuSign.keys.generate('ES256');         // buat kunci
const sig = await KartuSign.sign();             // tanda tangani → {payload, obj, kid, ...}
KartuSign.payload();                            // isi QR
KartuSign.render(2);                            // canvas kartu final (skala 2×)
await KartuSign.download('png', 2);             // unduh
KartuSign.qr.toDataURL(payload, 600, 'M');      // QR sebagai data URL PNG

// verifikasi tanpa UI
const r = await KartuSign.verify(publicKeyPem, payload, imageBytes);
// → { valid:true, signatureOk:true, hashMatch:true, data:{...} }
```

---

## Keamanan

| Aspek | Implementasi |
|---|---|
| **Integritas** | SHA-256 atas (metadata + byte gambar) ikut ditandatangani. Satu byte berubah → verifikasi gagal. |
| **Autentikasi** | Hanya pemegang kunci privat yang dapat menerbitkan tanda tangan sah. |
| **Non-repudiasi** | Tanda tangan asimetris; siapa pun dapat memeriksa dengan kunci publik. |
| **Penyimpanan kunci** | Kunci privat diekspor PKCS#8, dibungkus JSON, dienkripsi **AES-256-GCM** dengan kunci turunan **PBKDF2-SHA256 210.000 iterasi** dari frasa sandi, lalu disimpan di tabel `signing_keys` Supabase. **Server tidak pernah melihat kunci privat terbuka.** |
| **Otentikasi & otorisasi** | Supabase Auth (bcrypt, JWT + refresh token) dan **RLS** di setiap tabel — kebijakan akses ditegakkan database, bukan hanya UI. |
| **Jaringan** | Komunikasi hanya ke proyek Supabase Anda via HTTPS. Proses kriptografi tetap lokal di browser. |

### Batasan yang perlu Anda ketahui

- **Blob kunci privat tersimpan di database** (terenkripsi frasa sandi). Kekuatan perlindungannya = kekuatan frasa sandi manager. Untuk produksi serius, pertimbangkan HSM/KMS atau pemindahan penandatanganan ke sisi server.
- **Anon key ikut terkirim ke browser** (memang dirancang begitu). Keamanan data dijaga oleh **RLS** — jangan pernah menaruh *service role key* di aplikasi, dan jangan mematikan RLS.
- **Tidak ada pencabutan (revocation).** Payload memuat `kid` + `ts`; bila perlu, tambahkan daftar hitam `kid`/`cid` di sisi verifikator Anda.
- **Verifikasi payload-only tidak butuh gambar**; pencocokan hash gambar tersedia sebagai opsional bila file asli disertakan.
- **QR bukan pengaman visual.** Siapa pun bisa mencetak ulang QR yang valid; keaslian terbukti lewat verifikasi kriptografis, bukan lewat tampilan.

---

## Ukuran cetak QR

Modul (kotak terkecil) QR sebaiknya **≥ 0,33 mm** saat dicetak.

| Algoritma | ECL | Versi QR | Modul | Ukuran cetak minimum |
|---|---|---|---|---|
| ECDSA P-256 | L | 10 | 57 | ≈ 19 mm |
| ECDSA P-256 | M | 12 | 65 | ≈ 21 mm |
| ECDSA P-256 | Q | 15 | 77 | ≈ 25 mm |
| ECDSA P-256 | H | 17 | 85 | ≈ 28 mm |
| RSA-2048 | M | ±19 | 93 | ≈ 31 mm |

Pada kartu ID-1 (85,6 × 54 mm), 21 mm ≈ **24–27%** sisi pendek → atur slider **Ukuran 22–30%**.
Bila ruang sempit: pilih ECL **L** dan aktifkan **Key ID ringkas**.

---

## Isi folder

| Berkas | Keterangan |
|---|---|
| `KartuSign.html` | **Aplikasi jadi** — satu file, siap pakai/dibagikan |
| `contoh-kartu.png` | Kartu contoh (ID-1 300 dpi) untuk mencoba aplikasi |
| `app.template.html` | Sumber aplikasi (tanpa library QR) — edit di sini |
| `qrcode-generator.js` | Library QR (Kazuhiko Arase, MIT) yang ditanam saat build |
| `build.py` | Merakit `KartuSign.html` dari template + library (sekalian menulis `preview/` & `deploy/`) |
| `supabase/schema.sql` | **Skema database Supabase** (tabel + trigger + kebijakan RLS) — jalankan di SQL Editor |
| `deploy/` | Folder siap deploy Netlify (`index.html` + `netlify.toml` + contoh kartu) |
| `test.js` | Uji end-to-end otomatis (**132 kasus**) memakai jsdom + **mock server Supabase** (Auth/PostgREST/RLS), termasuk alur lintas-perangkat user→manager dan build+uji `KartuSign-Verifier.html` |
| `qrtest.js` | Uji round-trip QR: payload → matriks → decode |
| `make_sample.py` | Pembangkit `contoh-kartu.png` |

### Build ulang setelah mengedit template

```bash
python3 build.py
```

### Menjalankan uji

```bash
npm install jsdom jsqr --no-audit --no-fund   # sekali saja
node test.js      # 132 kasus: setup server, signup/login, RLS, kunci terenkripsi di server, unduh kartu oleh user,
                  # alur user→manager LINTAS PERANGKAT (2+ window jsdom berbagi mock backend),
                  # ganti password + re-wrap kunci, restore sesi, verifier build, kripto v2/v3
node qrtest.js    # round-trip decode QR di 4 level koreksi galat
```

### Pratinjau lewat server lokal

```bash
cd preview && python3 -m http.server 8080 --bind 0.0.0.0
# buka http://localhost:8080
```

> Catatan: Web Crypto API memerlukan *secure context*. Lewat `http://localhost` aman; lewat IP LAN (`http://192.168.x.x`) browser akan memblokir `crypto.subtle`. Gunakan HTTPS bila diakses dari perangkat lain.

---

## Lisensi komponen

- QR Code Generator — Kazuhiko Arase, MIT License (ditanam di dalam file).
- Selebihnya kode aplikasi ini bebas Anda pakai dan ubah sesuai kebutuhan instansi.

---

## Setup Supabase (sekali saja, ±5 menit, gratis)

1. Daftar/buka <https://supabase.com> → **New project** (pilih region terdekat, mis. Jakarta/Singapura; simpan password database).
2. Setelah proyek jadi: menu **SQL Editor** → *New query* → tempel **seluruh isi `supabase/schema.sql`** → **Run**. Ini membuat tabel `profiles`, `signing_keys`, `requests` + trigger + kebijakan RLS.
3. Menu **Authentication → Providers → Email** → matikan **Confirm email** → Save. (Pendaftaran lewat aplikasi tanpa verifikasi email.)
4. Menu **Settings → API** → salin **Project URL** dan **anon public** key.
5. Buka aplikasi KartuSign → panel **Hubungkan ke Supabase** → tempel URL + anon key → **Simpan & Uji Koneksi**.
6. Klik **Buat akun baru** → akun pertama **otomatis menjadi manager (level 2)**. Masuk tab *Kunci & Akun* → buat kunci → tambahkan akun-akun user.

> Keamanan: anon key memang untuk publik (dipakai browser); yang menjaga data adalah **RLS** di schema.sql. Jangan pernah menaruh *service_role key* di aplikasi.

## Deploy ke Netlify (online)

Folder `deploy/` sudah siap unggah: `index.html` (aplikasi), `contoh-kartu.png`, `netlify.toml` (header keamanan + no-cache). Supabase tetap diakses langsung dari browser (CORS diizinkan bawaan), jadi tidak perlu konfigurasi tambahan di Netlify.

**Tiga cara deploy**
1. **Netlify Drop (paling cepat, tanpa akun CLI)**: buka <https://app.netlify.com/drop> → tarik folder `deploy/` ke halaman → situs online dengan URL `https://nama-acak.netlify.app`.
2. **Netlify CLI**: `npm i -g netlify-cli` → `netlify login` → dari folder proyek: `netlify deploy --prod --dir=deploy`.
3. **Git**: push repo ini ke GitHub/GitLab → New site from Git di Netlify → *publish directory* = `deploy`.

**Checklist setelah deploy**
1. Buka URL situs → isi koneksi Supabase (panel *Hubungkan ke Supabase*) → **buat akun pertama** (otomatis manager) → buat kunci → unduh cadangan kunci privat.
2. Tambahkan akun user/manager lain di tab *Kunci & Akun* → bagikan URL situs ke mereka; masing-masing login dari perangkat sendiri dengan akun sendiri.
3. Unduh **KartuSign-Verifier.html** (kunci publik tertanam) → ganti nama menjadi `verifier.html` → taruh di folder `deploy/` → deploy ulang.
   Hasil: `https://situs-anda.netlify.app/verifier.html` = halaman cek keaslian publik untuk petugas di mana pun (tanpa login, tanpa Supabase, cukup tempel isi QR).

**Model data (v2.0 — online penuh)**
- Akun & login: **Supabase Auth** (server). Antrean pengajuan, gambar kartu, hasil approval, riwayat, dan blob kunci terenkripsi: **Postgres + RLS** (server).
- Alur user→manager **lintas perangkat**: user mengajukan dari rumah/HP → manager melihat antrean (auto-refresh ±7 detik) dari kantor → user melihat status *disetujui/ditolak(+catatan)* dan menyalin payload QR.
- Kunci privat manager tersimpan **terenkripsi frasa sandi** di server → manager bisa menandatangani dari perangkat mana pun; login otomatis membuka kunci dengan password sesi.
- Verifikasi keaslian tetap bisa **offline** lewat `verifier.html` (kunci publik tertanam) atau tab Verifikasi saat login.
- HTTPS bawaan Netlify membuat Web Crypto API aktif penuh (syarat secure context terpenuhi).

## Catatan rilis

**v2.1 (revisi atas masukan pengguna — user mengunduh kartu)**
- **Setelah approval, USER yang mengunduh kartu** (tugas download pindah dari manager ke user): tombol **Unduh Kartu** muncul di tabel *pengajuan saya* untuk status *disetujui* → kartu dirender di perangkat user + tombol **Unduh PNG / Unduh JPG / Unduh QR saja / Cetak**.
- Hasil **dijamin identik** dengan tampilan di layar manager: saat menyetujui, manager menyimpan `_layout` (posisi, ukuran, margin, rotasi, teks & ukuran caption, watermark, overlay, ECL, orientasi, ukuran tanda tangan basah, koordinat custom) dan `_sig` (byte tanda tangan basah, bila tidak disematkan sebagai `ss`) ke record pengajuan di server.
- Manager tetap dapat mengunduh/mencetak langsung untuk **kartu ad-hoc** (di luar antrean).
- Perbaikan bug latent: pratinjau crash (S.sig null) bila tanda tangan basah dimuat lalu metadata diedit sebelum menandatangani.
- Uji otomatis: 119 → **132 kasus** (tombol unduh user, rekonstruksi payload/gambar/tata letak lintas perangkat, round-trip tanda tangan basah via server).

**v2.0 (revisi atas masukan pengguna — database online)**
- **Backend Supabase**: login/akun via Supabase Auth (bcrypt + JWT), data via Postgres dengan **Row Level Security** (`supabase/schema.sql`).
- **Sinkron antar perangkat**: antrean pengajuan (termasuk gambar kartu), status approval + catatan, riwayat, akun, dan kunci tanda tangan kini hidup di server — bukan lagi di localStorage/IndexedDB per-browser. Polling otomatis ±7 detik.
- Akun pertama otomatis **manager**; manager menambah akun, mengubah level, menonaktifkan akun; minimal satu manager aktif.
- Kunci privat disimpan **terenkripsi AES-256-GCM/PBKDF2** di server; login manager otomatis membuka kunci; **ganti password membungkus ulang kunci** dengan password baru.
- Panel baru **Hubungkan ke Supabase** (URL + anon key, uji koneksi) dan form **daftar akun** di halaman login.
- Tanda tangan ad-hoc manager otomatis tercatat sebagai riwayat di server.
- Verifier (`KartuSign-Verifier.html`) tetap satu file **tanpa login & tanpa server**.
- Uji otomatis: 112 → **119 kasus** — termasuk **mock server Supabase penuh (Auth/PostgREST/RLS)** dan skenario **multi-perangkat** (user di window B mengajukan → manager di window A menandatangani → RLS menolak aksi ilegal user).

**v1.3 (revisi atas masukan pengguna)**
- **Tanda tangan basah (PNG) didukung**: dicetak sebagai lapisan visual di samping blok QR (ukuran dapat diatur), dan hash SHA-256 file-nya diikat ke payload (`sh`) — mengganti file tanda tangan membatalkan validitas.
- **Opsional "Sematkan tanda tangan ringkas di dalam QR"** (`ss`): monokrom 96×40 terkompresi; tab Verifikasi menampilkan ulang gambar tanda tangan langsung dari isi QR untuk dibandingkan dengan cetakan di kartu.
- Payload naik ke **v3** (field `sh`, `ss`); payload **v2 lama tetap terverifikasi** (kanonik per versi).
- Opsi lanjutan verifikasi: muat file tanda tangan untuk mencocokkan hash `sh`.
- Uji otomatis: 70 → **87 kasus**.

**v1.4 (revisi atas masukan pengguna)**
- **Role 2 level + form login**: level 1 *user* mengisi nama/ID kartu/masa berlaku dll. dan mengajukan approval; level 2 *manager* memegang antrean, membubuhkan QR sebagai tanda tangan digital, mengunduh/mencetak, serta mengelola kunci & akun.
- Antrean pengajuan disimpan di IndexedDB (gambar kartu ikut tersimpan); status *menunggu / disetujui / ditolak(+catatan)* terlihat oleh user; payload QR bisa disalin user setelah disetujui.
- Kartu ad-hoc tetap didukung manager di luar antrean.
- Uji otomatis: 87 → **112 kasus** (login salah/benar, gating tab per role, alur user→manager E2E, penolakan bercatat, manajemen akun).

**v1.2 (revisi atas masukan pengguna)**
- **Teks di bawah QR diperbesar**: default ±2,6× lebih besar dari sebelumnya, plus slider *Ukuran teks* (8–30% lebar badge) dan pembungkusan otomatis maksimal 2 baris agar tidak terpangkas.
- **Verifikasi disederhanakan**: cukup **tempel isi QR payload mentah** → putusan **✓ KARTU INI ASLI / ✗ KARTU TIDAK ASLI**. Tidak perlu kunci publik, tidak perlu upload gambar kartu.
- Skema tanda tangan naik ke **v2**: hash gambar ikut di dalam string kanonik sehingga verifikasi mungkin tanpa file gambar. Payload v1 lama ditolak dengan pesan jelas.
- **Trust store**: kunci tertanam (file verifier), kunci perangkat, riwayat approval; kid asing → *ISSUER TIDAK DIKENAL*.
- Tombol baru **"Unduh Aplikasi Verifier (kunci tertanam)"** → `KartuSign-Verifier.html` untuk petugas.
- Uji otomatis: 53 → **70 kasus** (termasuk end-to-end file verifier pada instance browser terpisah).

**v1.1 (perbaikan atas masukan pengguna)**
- **Perbaikan bug upload**: sebelumnya variabel internal `bytes` dipakai sebelum dideklarasikan sehingga upload gambar (PNG/JPG) gagal diam-diam dan pratinjau tidak muncul. Sekarang diperbaiki + ada pesan error yang jelas bila file bukan gambar atau rusak.
- **Default orientasi POTRET**: kontrol baru *Orientasi kartu* (Potret/Lanskap). Potret = strip tanda tangan vertikal (rotasi 90°) otomatis aktif.
- Perhitungan jejak badge saat rotasi diperbaiki (tidak terpotong tepi kartu pada semua preset posisi & saat digeser manual).
- Akses `localStorage` dibungkus aman sehingga aplikasi tetap hidup di iframe sandbox / mode privat.
- `contoh-kartu.png` diganti versi potret.
- Uji otomatis bertambah: 34 → **53 kasus** (termasuk regresi upload PNG & orientasi).
