const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { webcrypto } = require('crypto');

const html = fs.readFileSync(path.join(__dirname, 'KartuSign.html'), 'utf8');

const MOCK_BASE = 'https://mock.supabase.co';
const APIKEY = 'mock-anon-key';

/* =====================================================================
   MOCK SUPABASE SERVER (Auth + PostgREST + RLS) — in-memory,
   dibagikan oleh SEMUA window JSDOM → mensimulasikan multi-perangkat.
===================================================================== */
const backend = {
  users: [],            // {id,email,password,username}
  tokens: new Map(),    // access_token -> {uid, refresh_token}
  refresh: new Map(),   // refresh_token -> uid
  profiles: [],         // {id,username,role,active,created_at}
  heartbeat: [],        // {id,last_beat,note} — keep-alive
  cardSeq: {},          // 'YYYY-MM' → nomor kartu terakhir
  signing_keys: [],     // {key_id,alg,kid,pubkey_pem,priv_enc,locked,created_by,created_at}
  requests: [],         // {id,created_by,by_name,card_name,card_data,image_b64,image_mime,status,note,payload,kid,signed_by,created_at,updated_at}
  log: []
};
const uid = () => webcrypto.randomUUID();
const nowIso = () => new Date().toISOString();

function actorOf(headers) {
  const auth = headers['authorization'] || headers['Authorization'];
  if (!auth || !/^Bearer /i.test(auth)) return null;
  const tok = backend.tokens.get(auth.slice(7));
  if (!tok) return undefined; // token invalid
  const prof = backend.profiles.find(p => p.id === tok.uid);
  return { uid: tok.uid, profile: prof || null };
}
const isManager = (a) => !!(a && a.profile && a.profile.role === 'manager' && a.profile.active !== false);
const hasManager = () => backend.profiles.some(p => p.role === 'manager' && p.active !== false);

function makeSession(u) {
  const at = 'tok-' + uid(), rt = 'ref-' + uid();
  backend.tokens.set(at, { uid: u.id, refresh_token: rt });
  backend.refresh.set(rt, u.id);
  return { access_token: at, refresh_token: rt, token_type: 'bearer',
           expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
           user: { id: u.id, email: u.email } };
}
function resp(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function parseQuery(url) {
  const u = new URL(url);
  return { table: u.pathname.replace('/rest/v1/', ''), params: u.searchParams };
}
function applyFilters(rows, params) {
  let out = rows.slice();
  for (const [k, v] of params.entries()) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
    const m = /^eq\.(.*)$/.exec(v);
    if (!m) continue;
    const val = decodeURIComponent(m[1]);
    out = out.filter(r => String(r[k]) === String(val === 'true' ? true : val === 'false' ? false : val));
  }
  return out;
}
function applyOrderLimitSelect(rows, params) {
  let out = rows;
  const order = params.get('order');
  if (order) {
    const [col, dir] = order.split('.');
    out = out.slice().sort((a, b) => dir === 'desc' ? (a[col] < b[col] ? 1 : -1) : (a[col] > b[col] ? 1 : -1));
  }
  const limit = params.get('limit');
  if (limit) out = out.slice(0, Number(limit));
  const sel = params.get('select');
  if (sel && sel !== '*') {
    const cols = sel.split(',');
    out = out.map(r => Object.fromEntries(cols.filter(c => c in r).map(c => [c, r[c]])));
  }
  return out;
}
const RLS_FAIL = (t) => resp(401, { code: '42501', message: 'new row violates row-level security policy for table "' + t + '"' });

async function sbFetch(urlStr, opts) {
  opts = opts || {};
  const headers = {};
  const hh = opts.headers || {};
  if (typeof hh.forEach === 'function') hh.forEach((v, k) => headers[k.toLowerCase()] = v);
  else for (const k of Object.keys(hh)) headers[k.toLowerCase()] = hh[k];
  const body = opts.body ? JSON.parse(opts.body) : null;
  const url = String(urlStr);
  backend.log.push((opts.method || 'GET') + ' ' + url.replace(MOCK_BASE, ''));
  if (!url.startsWith(MOCK_BASE)) return resp(0, { message: 'URL luar tidak dimock: ' + url });

  /* ---------------- AUTH ---------------- */
  if (url.includes('/auth/v1/')) {
    if (url.includes('/signup')) {
      const email = String(body.email || '').toLowerCase();
      if (backend.users.some(u => u.email === email)) return resp(422, { msg: 'User already registered' });
      const uname = (body.data && body.data.username) || email.split('@')[0];
      if (backend.profiles.some(p => p.username === uname)) return resp(422, { msg: 'User already registered' });
      const u = { id: uid(), email, password: body.password, username: uname };
      backend.users.push(u);
      backend.profiles.push({ id: u.id, username: uname, full_name: (body.data && body.data.full_name) || '', role: 'user', active: true, created_at: nowIso() }); // trigger handle_new_user (v2.3: + full_name)
      return resp(200, { ...makeSession(u), user: { id: u.id, email } });
    }
    if (url.includes('/token?grant_type=password')) {
      const u = backend.users.find(x => x.email === String(body.email || '').toLowerCase());
      if (!u || u.password !== body.password) return resp(400, { error: 'invalid_grant', msg: 'Invalid login credentials' });
      return resp(200, { ...makeSession(u), user: { id: u.id, email: u.email } });
    }
    if (url.includes('/token?grant_type=refresh_token')) {
      const uid2 = backend.refresh.get(body.refresh_token);
      const u = uid2 && backend.users.find(x => x.id === uid2);
      if (!u) return resp(400, { error: 'invalid_grant', msg: 'Invalid Refresh Token' });
      return resp(200, { ...makeSession(u), user: { id: u.id, email: u.email } });
    }
    if (url.endsWith('/auth/v1/user') && (opts.method || '') === 'PUT') {
      const a = actorOf(headers);
      if (!a) return resp(401, { msg: 'invalid claim: missing sub claim' });
      const u = backend.users.find(x => x.id === a.uid);
      if (body.password) u.password = body.password;
      return resp(200, { id: u.id, email: u.email });
    }
    if (url.endsWith('/auth/v1/logout')) {
      const auth = headers['authorization'] || '';
      backend.tokens.delete(auth.slice(7));
      return resp(204, null);
    }
    return resp(404, { msg: 'auth endpoint tidak dimock: ' + url });
  }

  /* ---------------- REST (PostgREST) ---------------- */
  if (headers['apikey'] !== APIKEY) return resp(401, { code: 'PGRST301', message: 'No API key found in request' });
  const a = actorOf(headers);
  if (a === undefined) return resp(401, { code: 'PGRST301', message: 'Could not verify the identity of the user' });
  if (url.includes('/rest/v1/rpc/next_card_id')) {          // v2.4: RPC nomor kartu otomatis
    if (!a) return resp(401, { code: '42501', message: 'RLS' });
    const per = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Jakarta' }).slice(0, 7); // 'YYYY-MM'
    backend.cardSeq[per] = (backend.cardSeq[per] || 0) + 1;
    return resp(200, 'PUR-' + per + '-' + String(backend.cardSeq[per]).padStart(4, '0'));
  }
  if (url.includes('/rest/v1/rpc/update_my_full_name')) {   // v2.3: security-definer RPC
    if (!a) return resp(401, { code: '42501', message: 'RLS' });
    const nm = String((body && body.nama) || '').trim();
    if (nm.length < 2) return resp(400, { message: 'Nama lengkap minimal 2 karakter' });
    const pr = backend.profiles.find(x => x.id === a.uid);
    if (pr) pr.full_name = nm;
    return resp(204, null);
  }
  const { table, params } = parseQuery(url);
  const method = (opts.method || 'GET').toUpperCase();
  if (!['profiles', 'signing_keys', 'requests', 'heartbeat'].includes(table)) return resp(404, { message: 'table not found: ' + table });
  const rows = backend[table];

  if (table === 'heartbeat') {   // keep-alive: boleh anonim (RLS asli mengizinkan anon+authenticated)
    if (method === 'GET') return resp(200, rows);
    if (method === 'POST') {
      if (!['app', 'cron'].includes(body.id)) return resp(400, { message: 'id heartbeat tidak valid' });
      let rec = rows.find(h => h.id === body.id);
      if (rec) Object.assign(rec, body); else { rec = { ...body }; rows.push(rec); }
      return resp(201, (headers['prefer'] || '').includes('return=representation') ? [rec] : null);
    }
  }

  if (method === 'GET') {
    if (!a) return resp(200, []); // RLS: anon tidak melihat apa pun
    let vis = rows;
    if (table === 'requests') vis = rows.filter(r => r.created_by === a.uid || isManager(a));
    return resp(200, applyOrderLimitSelect(applyFilters(vis, params), params));
  }
  if (method === 'POST') {
    if (!a) return RLS_FAIL(table);
    const prefer = headers['prefer'] || '';
    if (table === 'profiles') {
      if (body.id !== a.uid) return RLS_FAIL(table);
      rows.push({ role: 'user', active: true, created_at: nowIso(), ...body });
      return resp(201, prefer.includes('return=representation') ? [rows[rows.length - 1]] : null);
    }
    if (table === 'signing_keys') {
      if (!isManager(a)) return RLS_FAIL(table);
      const i = rows.findIndex(r => r.key_id === body.key_id);
      const rec = { created_at: nowIso(), ...body };
      if (i >= 0 && prefer.includes('merge-duplicates')) rows[i] = { ...rows[i], ...rec };
      else rows.push(rec);
      const saved = rows.find(r => r.key_id === body.key_id);
      return resp(201, prefer.includes('return=representation') ? [saved] : null);
    }
    if (table === 'requests') {
      if (body.created_by !== a.uid) return RLS_FAIL(table);
      const rec = { id: uid(), by_name: '', card_name: 'kartu.png', card_data: {}, image_b64: '', image_mime: 'image/png',
                    status: 'menunggu', note: '', payload: '', kid: '', signed_by: '',
                    created_at: nowIso(), updated_at: nowIso(), ...body };
      rows.push(rec);
      return resp(201, prefer.includes('return=representation') ? [rec] : null);
    }
  }
  if (method === 'PATCH') {
    if (!a) return RLS_FAIL(table);
    const targets = applyFilters(rows, params);
    for (const row of targets) {
      if (table === 'profiles' && !((row.id === a.uid && !hasManager()) || isManager(a))) return RLS_FAIL(table);
      if (table === 'signing_keys' && !isManager(a)) return RLS_FAIL(table);
      if (table === 'requests' && !isManager(a)) return RLS_FAIL(table);
    }
    for (const row of targets) {
      Object.assign(row, body);
      if (table === 'requests') row.updated_at = nowIso(); // trigger set_updated_at
    }
    const prefer = headers['prefer'] || '';
    return resp(200, prefer.includes('return=representation') ? targets : null);
  }
  if (method === 'DELETE') {
    if (!a) return RLS_FAIL(table);
    const targets = applyFilters(rows, params);
    for (const row of targets) {
      if (table === 'requests') { if (!(row.created_by === a.uid || isManager(a))) return RLS_FAIL(table); }
      else if (!isManager(a)) return RLS_FAIL(table);
    }
    for (const row of targets) rows.splice(rows.indexOf(row), 1);
    return resp(204, null);
  }
  return resp(405, { message: 'method tidak dimock' });
}

/* =====================================================================
   STUB BROWSER (crypto, canvas, fetch → mock supabase, prompt/confirm)
===================================================================== */
const vc = new VirtualConsole();
const errors = [];
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.stack || e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
vc.on('warn', () => {});

function installStubs(window, seed) {
  Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true, writable: true });
  window.isSecureContext = true;
  window.fetch = (u, o) => sbFetch(String(u), o || {});

  const noopCtx = new Proxy({}, {
    get(t, p) {
      if (p === 'canvas') return t.__c;
      if (p === 'measureText') return () => ({ width: 10 });
      if (p === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
      if (p === 'createImageData') return (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
      return () => undefined;
    },
    set() { return true; }
  });
  window.HTMLCanvasElement.prototype.getContext = function () { const c = Object.create(noopCtx); c.__c = this; return c; };
  window.HTMLCanvasElement.prototype.toBlob = function (cb) { cb && cb(new window.Blob(['x'], { type: 'image/png' })); };
  window.HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/png;base64,AA=='; };
  window.Image = class {
    constructor() { this.naturalWidth = 0; this.naturalHeight = 0; this._src = ''; }
    set src(v) { this._src = v; setTimeout(() => { this.naturalWidth = 800; this.naturalHeight = 500; this.onload && this.onload(); }, 0); }
    get src() { return this._src; }
  };
  window.URL.createObjectURL = () => 'blob:stub';
  window.URL.revokeObjectURL = () => {};
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get() { return 640; }, configurable: true });
  window.__promptQueue = [];
  window.prompt = () => window.__promptQueue.length ? window.__promptQueue.shift() : null;
  window.confirm = () => true;
  if (seed) seed(window);
}
const seedConfig = (w) => w.localStorage.setItem('kartusign.sb.config.v1', JSON.stringify({ url: MOCK_BASE, key: APIKEY }));
function makeDom(h, seed) {
  return new JSDOM(h, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://localhost/', virtualConsole: vc, beforeParse: (w) => installStubs(w, seed) });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const domA = makeDom(html);
const winA = domA.window, docA = winA.document;

(async () => {
  await sleep(500);
  const KS = winA.KartuSign, D = KS._debug;
  const results = [];
  const check = (name, cond, extra) => { results.push({ name, ok: !!cond, extra: extra === undefined ? '' : String(extra) }); console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra !== undefined && !cond ? '  [' + extra + ']' : '')); };
  const $ = (id) => docA.getElementById(id);

  check('Hook API KartuSign tersedia', !!KS && typeof KS.verify === 'function');
  check('Library QR termuat', typeof winA.qrcode === 'function');
  check('init() berjalan tanpa error', errors.length === 0, errors.slice(0, 3).join(' || '));
  check('Chip crypto aktif', /Web Crypto aktif/.test($('chipCrypto').textContent));

  /* ============ 1. SETUP SERVER (panel Supabase) ============ */
  const panel = (w, n) => w.document.querySelector('[data-panel="' + n + '"]');
  check('Tanpa konfigurasi → panel setup tampil, login tertutup', !panel(winA, 'setup').classList.contains('hide') && panel(winA, 'login').classList.contains('hide'));
  $('sbUrl').value = 'bukan-url'; $('sbKey').value = 'x';
  $('btnSaveSb').click(); await sleep(250);
  check('URL tidak valid → pesan error', /tidak valid/i.test($('sbErr').textContent), $('sbErr').textContent);
  $('sbUrl').value = MOCK_BASE; $('sbKey').value = 'key-salah';
  $('btnSaveSb').click(); await sleep(250);
  check('Anon key salah → ditolak (401)', /ditolak/i.test($('sbErr').textContent), $('sbErr').textContent);
  $('sbUrl').value = MOCK_BASE; $('sbKey').value = APIKEY;
  $('btnSaveSb').click(); await sleep(400);
  check('Konfigurasi benar → panel login tampil', !panel(winA, 'login').classList.contains('hide') && panel(winA, 'setup').classList.contains('hide'));

  /* ============ 2. SIGNUP: akun pertama = manager otomatis ============ */
  $('btnToSignup').click(); await sleep(50);
  check('Form daftar terbuka', !$('signupBox').classList.contains('hide') && $('loginBox').classList.contains('hide'));
  $('suName').value = ''; $('suUser').value = 'boss'; $('suPass').value = 'boss12345'; $('suPass2').value = 'boss12345';
  $('btnSignup').click(); await sleep(150);
  check('Pendaftaran TANPA Nama ditolak (wajib)', /Nama lengkap wajib/.test($('suErr').textContent) && backend.users.length === 0, $('suErr').textContent);
  $('suName').value = 'Budi Bos Besar';
  $('suUser').value = 'BO';
  $('btnSignup').click(); await sleep(150);
  check('Username tidak valid ditolak', /Username 3/.test($('suErr').textContent), $('suErr').textContent);
  $('suUser').value = 'boss'; $('suPass2').value = 'beda';
  $('btnSignup').click(); await sleep(150);
  check('Konfirmasi password beda ditolak', /tidak sama/i.test($('suErr').textContent));
  $('suPass2').value = 'boss12345';
  $('btnSignup').click(); await sleep(900);
  D.stopPolling();
  check('Signup akun pertama → login sebagai manager (level 2)', /level 2/.test($('chipSession').textContent), $('chipSession').textContent);
  check('Panel Approval terbuka untuk manager', !panel(winA, 'approve').classList.contains('hide') && panel(winA, 'login').classList.contains('hide'));
  check('Server: profil pertama dipromosikan jadi manager', backend.profiles[0] && backend.profiles[0].role === 'manager' && backend.profiles[0].username === 'boss');
  check('Nama lengkap tersimpan di server, sesi & chip', backend.profiles[0].full_name === 'Budi Bos Besar' && KS.state.session.fullName === 'Budi Bos Besar' && /Budi Bos Besar \(boss\)/.test($('chipSession').textContent), $('chipSession').textContent);
  check('Keep-alive: heartbeat tertulis otomatis ke server', backend.heartbeat.some(h => h.id === 'app' && h.last_beat), JSON.stringify(backend.heartbeat).slice(0, 90));
  const beat2 = await D.sendHeartbeat();
  check('Keep-alive: di-throttle (< 3 hari → tidak menulis lagi)', beat2 === false);
  const beat3 = await D.sendHeartbeat(true);
  check('Keep-alive: force → upsert, tetap 1 baris (tidak duplikat)', beat3 === true && backend.heartbeat.filter(h => h.id === 'app').length === 1);
  check('Sesi Supabase tersimpan di localStorage', !!winA.localStorage.getItem('kartusign.sb.session.v1'));

  /* ============ 3. MANAGER MENAMBAH AKUN (server) ============ */
  docA.querySelector('nav.tabs button[data-tab="keys"]').click(); await sleep(200);
  check('Tabel akun menampilkan boss', /boss/.test($('accBody').textContent));
  $('accName').value = ''; $('accUser').value = 'noname'; $('accRole').value = 'user'; $('accPass').value = 'noname123';
  $('btnAddAcc').click(); await sleep(400);
  check('Tambah akun TANPA Nama ditolak', !backend.profiles.some(p => p.username === 'noname'));
  $('accName').value = 'Siti Aminah'; $('accUser').value = 'siti'; $('accRole').value = 'user'; $('accPass').value = 'siti12345';
  $('btnAddAcc').click(); await sleep(600);
  check('Akun user "siti" dibuat di server', backend.profiles.some(p => p.username === 'siti' && p.role === 'user') && /siti/.test($('accBody').textContent));
  check('Nama lengkap akun tersimpan & tampil di tabel akun', backend.profiles.find(p => p.username === 'siti').full_name === 'Siti Aminah' && /Siti Aminah/.test($('accBody').textContent));
  $('accName').value = 'Staff Kedua'; $('accUser').value = 'staff2'; $('accRole').value = 'manager'; $('accPass').value = 'staff12345';
  $('btnAddAcc').click(); await sleep(600);
  check('Akun manager "staff2" dibuat dgn role manager', backend.profiles.some(p => p.username === 'staff2' && p.role === 'manager'));
  $('accName').value = 'Siti Kembar'; $('accUser').value = 'siti'; $('accPass').value = 'apapun123';
  $('btnAddAcc').click(); await sleep(400);
  check('Username duplikat ditolak server', backend.profiles.filter(p => p.username === 'siti').length === 1);

  /* ============ 4. KUNCI: dibuat → tersimpan TERENKRIPSI di server ============ */
  $('kAlg').value = 'ES256'; $('kPass').value = '';
  $('btnGen').click(); await sleep(1600);
  const pubPem = $('pubPem').value.trim();
  check('Kunci ES256 dibuat', !!KS.state.keys.ES256 && !!KS.state.keys.ES256.privateKey);
  check('PEM publik dihasilkan', /-----BEGIN PUBLIC KEY-----/.test(pubPem));
  const kidES = KS.state.keys.ES256.kid;
  const keyRow = backend.signing_keys.find(r => r.key_id === 'ES256');
  check('Kunci tersimpan di server (signing_keys)', !!keyRow && keyRow.kid === kidES);
  check('Kunci privat di server TERENKRIPSI (locked)', keyRow && keyRow.locked === true && JSON.parse(keyRow.priv_enc).protected === true);
  let blobPlain = null;
  try { blobPlain = await D.decryptBlob(JSON.parse(keyRow.priv_enc).payload, 'boss12345'); } catch (e) {}
  check('Blob server terbuka dgn password sesi (bukan plaintext di DB)', !!blobPlain && /"priv"/.test(blobPlain));

  /* ============ 5. MUAT KARTU + TANDA TANGAN (ad-hoc → riwayat server) ============ */
  docA.querySelector('nav.tabs button[data-tab="approve"]').click(); await sleep(150);
  const imgBytes = new Uint8Array(1234).map((_, i) => (i * 7 + 13) & 0xff);
  KS.state.card = { file: null, name: 'kartu-uji.png', img: { naturalWidth: 800, naturalHeight: 500 }, bytes: imgBytes, w: 800, h: 500 };
  D.render(); D.renderSigInfo();
  check('Menu manager ramping: tidak ada tombol unduh/cetak/format kartu', !$('btnDownload') && !$('btnPrint') && !$('dlFormat') && !$('dropCardM'));
  check('Tombol Approve NONAKTIF tanpa permintaan aktif (ad-hoc dihapus)', $('btnSign').disabled === true);
  $('mCardId').value = 'KTR-2026-000123'; $('mHolder').value = 'Budi Santoso';
  $('mApprover').value = 'Kepala Divisi SDM'; $('mReason').value = 'Kartu dinyatakan sah';
  const sig = await D.signCard();
  check('Tanda tangan dibuat (signCard)', !!sig && !!sig.payload);
  const payloadObj = sig ? JSON.parse(sig.payload) : {};
  check('Payload punya field lengkap', ['v', 'alg', 'kid', 'ts', 'cid', 'hld', 'apr', 'rsn', 'h', 's'].every(k => k in payloadObj), Object.keys(payloadObj).join(','));
  check('Panjang tanda tangan ECDSA = 64 byte', KS.utils.b64uToBytes(payloadObj.s).length === 64);
  check('Payload cukup ringkas untuk QR', sig && sig.payload.length < 400, sig.payload.length);
  check('Hash gambar = SHA-256(bytes)', payloadObj.h === KS.utils.b64u(await winA.crypto.subtle.digest('SHA-256', imgBytes)));
  let qrModules = 0;
  try { const q = winA.qrcode(0, 'M'); q.addData(sig.payload, 'Byte'); q.make(); qrModules = q.getModuleCount(); } catch (e) {}
  check('Payload muat dalam QR', qrModules >= 21, 'modul=' + qrModules);

  /* ============ 6. VERIFIKASI POSITIF & NEGATIF (payload-only) ============ */
  $('vPayload').value = sig.payload; $('vKey').value = '';
  KS.state.verifyImg = { file: null, bytes: imgBytes, name: 'kartu-uji.png' };
  docA.querySelector('nav.tabs button[data-tab="verify"]').click();
  $('btnVerify').click(); await sleep(700);
  check('Tempel payload → ✓ KARTU INI ASLI', /✓ KARTU INI ASLI/.test($('vResult').textContent), $('vResult').textContent.slice(0, 80).replace(/\s+/g, ' '));
  const tampered = imgBytes.slice(); tampered[500] ^= 0x01;
  KS.state.verifyImg = { file: null, bytes: tampered, name: 'palsu.png' };
  $('btnVerify').click(); await sleep(600);
  check('Gambar diubah 1 byte → GAMBAR BERBEDA', /GAMBAR BERBEDA/.test($('vResult').textContent));
  const forged = JSON.parse(sig.payload); forged.hld = 'Orang Lain';
  $('vPayload').value = JSON.stringify(forged);
  KS.state.verifyImg = { file: null, bytes: imgBytes, name: 'kartu-uji.png' };
  $('btnVerify').click(); await sleep(600);
  check('Metadata dipalsukan → ✗ TIDAK ASLI', /✗ KARTU TIDAK ASLI/.test($('vResult').textContent));
  const badSig = JSON.parse(sig.payload);
  badSig.s = badSig.s.slice(0, -4) + (badSig.s.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  $('vPayload').value = JSON.stringify(badSig);
  $('btnVerify').click(); await sleep(600);
  check('Tanda tangan dirusak → ✗ TIDAK ASLI', /✗ KARTU TIDAK ASLI/.test($('vResult').textContent));
  KS.state.verifyImg = { file: null, bytes: null, name: '' };
  $('vPayload').value = sig.payload;
  $('btnVerify').click(); await sleep(600);
  check('Verifikasi tanpa gambar → ASLI', /✓ KARTU INI ASLI/.test($('vResult').textContent));
  check('API verify() tanpa gambar → valid', (await KS.verify(pubPem, sig.payload)).valid === true);
  check('API verify() menolak gambar berbeda', (await KS.verify(pubPem, sig.payload, tampered)).valid === false);
  $('btnSelfTest').click(); await sleep(900);
  check('Uji mandiri lolos', /berfungsi/.test($('vResult').textContent));

  /* ============ 7. RSA-2048 + blob + impor (port test lama) ============ */
  $('kAlg').value = 'RS256'; $('qrAlgo').value = 'RS256';
  $('kAlg').dispatchEvent(new winA.Event('change'));
  $('btnGen').click(); await sleep(4000);
  check('Kunci RSA-2048 dibuat & disimpan ke server', !!KS.state.keys.RS256 && backend.signing_keys.some(r => r.key_id === 'RS256'));
  docA.querySelector('nav.tabs button[data-tab="approve"]').click();
  KS.state.card = { file: null, name: 'kartu-uji.png', img: { naturalWidth: 800, naturalHeight: 500 }, bytes: imgBytes, w: 800, h: 500 };
  D.render(); D.renderSigInfo();
  const rsaSig = await D.signCard();
  check('Tanda tangan RSA dibuat', rsaSig.alg === 'RS256');
  check('Panjang tanda tangan RSA = 256 byte', KS.utils.b64uToBytes(JSON.parse(rsaSig.payload).s).length === 256);
  let rsaModules = 0;
  try { const q = winA.qrcode(0, 'M'); q.addData(rsaSig.payload, 'Byte'); q.make(); rsaModules = q.getModuleCount(); } catch (e) {}
  check('Payload RSA muat dalam QR', rsaModules > 0, 'modul=' + rsaModules);
  check('Verifikasi RSA via API → valid', (await KS.verify($('pubPem').value.trim(), rsaSig.payload, imgBytes)).valid === true);
  $('qrAlgo').value = 'ES256'; $('kAlg').value = 'ES256'; $('qrAlgo').dispatchEvent(new winA.Event('change'));
  const blob = await D.encryptBlob('SECRET-DATA', 'pass-uji');
  check('Blob AES-GCM bolak-balik', (await D.decryptBlob(blob, 'pass-uji')) === 'SECRET-DATA');
  let wrongRejected = false;
  try { await D.decryptBlob(blob, 'salah'); } catch (e) { wrongRejected = true; }
  check('Frasa sandi salah ditolak', wrongRejected);
  const privPem = KS.utils.derToPem(KS.utils.b64uToBytes(KS.utils.b64u(await winA.crypto.subtle.exportKey('pkcs8', KS.state.keys.ES256.privateKey))), 'PRIVATE KEY');
  const reimported = await D.importPrivateFromText(privPem, '');
  check('Impor PEM PKCS#8 privat round-trip', reimported.alg === 'ES256' && reimported.kid === kidES);
  const pubOnly = await KS.keys.importPublic(pubPem);
  check('Impor PEM publik berhasil', pubOnly.alg === 'ES256' && !!pubOnly.publicKey);
  const cs2 = D.canonicalString({ v: 2, alg: 'ES256', kid: 'x', ts: 1, cid: '', hld: '', apr: '', exp: '', rsn: '', h: '' });
  check('Kanonik v2 berprefiks KS2', cs2.startsWith('KS2|'));
  check('Kanonik v3 berprefiks KS3 + slot sh/ss', D.canonicalString({ ...JSON.parse(sig.payload), v: 3, sh: '', ss: '', s: undefined }).startsWith('KS3|'));

  /* ============ 8. REGRESI PNG + orientasi + caption + badge ============ */
  const pngLike = new winA.File([imgBytes], 'kartu-uji.png', { type: 'image/png' });
  let loaded = null, loadErr = null;
  try { loaded = await Promise.race([D.loadImageFile(pngLike, 'card'), new Promise((_, rj) => setTimeout(() => rj(new Error('TIMEOUT')), 4000))]); } catch (e) { loadErr = e; }
  check('Upload PNG: loadImageFile resolve', !!loaded && !loadErr, loadErr && loadErr.message);
  check('Upload PNG: bytes utuh', !!loaded && loaded.bytes.length === imgBytes.length);
  let rejMsg = '';
  try { await D.loadImageFile(new winA.File(['x'], 'data.pdf', { type: 'application/pdf' }), 'card'); } catch (e) { rejMsg = e.message; }
  check('File non-gambar ditolak', /bukan gambar/i.test(rejMsg), rejMsg);
  check('Orientasi default = potret', $('orient').value === 'potret');
  check('Potret: rotasi 90° default aktif', $('qrRotate').checked === true);
  let fpOk = true;
  for (const pos of ['tl', 'tr', 'bl', 'br']) {
    $('qrPos').value = pos; $('qrPos').dispatchEvent(new winA.Event('change'));
    const b = D.computeBadge();
    if (!(b.fx >= 0 && b.fy >= 0 && b.fx + b.fw <= KS.state.card.w && b.fy + b.fh <= KS.state.card.h)) fpOk = false;
  }
  check('Badge tetap di dalam kanvas (4 posisi)', fpOk);
  { const bg = D.computeBadge(); const q = bg.w - bg.pad * 2;
    check('Geometri badge: QR + caption MUAT di dalam border abu-abu', q >= 40 && bg.h >= bg.pad + q + bg.capH && bg.w >= bg.pad * 2 + q, 'w=' + bg.w + ' q=' + q + ' h=' + bg.h); }
  $('qrPos').value = 'br'; $('qrPos').dispatchEvent(new winA.Event('change'));
  const b16 = D.computeBadge();
  check('Caption ≥14% lebar badge', b16.capFs >= Math.round(b16.qrSize * 0.14), 'capFs=' + b16.capFs);

  /* ============ 9. PERANGKAT B: user "siti" login & mengajukan ============ */
  const domB = makeDom(html, seedConfig);
  const winB = domB.window, docB = winB.document;
  await sleep(500);
  const KSB = winB.KartuSign, DB = KSB._debug, $B = (id) => docB.getElementById(id);
  check('Perangkat B: config terbaca → langsung panel login', !panel(winB, 'setup').classList.contains('hide') === false && !panel(winB, 'login').classList.contains('hide'));
  $B('liUser').value = 'siti'; $B('liPass').value = 'password-salah';
  $B('btnLogin').click(); await sleep(500);
  check('B: password salah → ditolak server', /salah/.test($B('liErr').textContent), $B('liErr').textContent);
  $B('liPass').value = 'siti12345';
  $B('btnLogin').click(); await sleep(900);
  DB.stopPolling();
  check('B: login siti → level 1, tab Pengajuan', /level 1/.test($B('chipSession').textContent) && !panel(winB, 'request').classList.contains('hide'));
  check('B: tab manager disembunyikan (approval/kunci/riwayat)', panel(winB, 'approve').classList.contains('hide') && panel(winB, 'keys').classList.contains('hide') && docB.querySelector('nav.tabs button[data-tab="approve"]').classList.contains('hide'));
  const cidAuto = $B('mCardId').value;
  check('B: ID kartu otomatis terisi, format PUR-tahun-bulan-NNNN', /^PUR-\d{4}-\d{2}-\d{4}$/.test(cidAuto), cidAuto);
  check('B: pengesah & keterangan dikunci (readonly, nilai tetap)', $B('mApprover').readOnly && $B('mApprover').value === 'Manager Purchasing' && $B('mReason').readOnly && $B('mReason').value === 'Kartu ini dinyatakan Sah dan Asli di keluarkan oleh Purchasing Section');
  const cidNext = await DB.SB.nextCardId();
  check('B: nomor berikutnya increment +1 (periode sama)', cidNext.slice(0, -4) === cidAuto.slice(0, -4) && Number(cidNext.slice(-4)) === Number(cidAuto.slice(-4)) + 1, cidAuto + ' → ' + cidNext);
  const reqBytes = new Uint8Array(900).map((_, i) => (i * 13 + 5) & 0xff);
  await DB.loadImageFile(new winB.File([reqBytes], 'kartu-request.png', { type: 'image/png' }), 'card');
  $B('mCardId').value = 'KTR-REQ-001'; $B('mHolder').value = 'Siti Aminah'; $B('mValid').value = '2027-12-31';
  $B('btnSubmitReq').click(); await sleep(900);
  const row1 = backend.requests.find(r => (r.card_data || {}).cid === 'KTR-REQ-001');
  check('B: pengajuan terkirim ke SERVER (status menunggu, by_name = nama lengkap)', !!row1 && row1.status === 'menunggu' && row1.by_name === 'Siti Aminah', row1 && row1.by_name);
  check('B: gambar kartu ikut tersimpan (base64)', row1 && row1.image_b64 && row1.image_b64.length > 100);
  check('B: tabel "pengajuan saya" → menunggu', /menunggu/.test($B('myReqBody').textContent));
  check('B: setelah submit, nomor baru otomatis diambil lagi', /^PUR-\d{4}-\d{2}-\d{4}$/.test($B('mCardId').value) && $B('mCardId').value !== cidAuto, $B('mCardId').value);
  $B('mCardId').value = '';
  const nBefore = backend.requests.length;
  $B('btnSubmitReq').click(); await sleep(300);
  check('B: pengajuan tanpa ID kartu ditolak', backend.requests.length === nBefore);
  $B('mCardId').value = 'KTR-REQ-001';

  /* ============ 10. PERANGKAT A: manager memproses & menandatangani ============ */
  await D.renderQueue();
  check('A: antrean manager memuat permintaan siti (lintas perangkat)', /KTR-REQ-001/.test($('queueBody').textContent) && /Siti Aminah/.test($('queueBody').textContent));
  const procBtn = docA.querySelector('#queueBody [data-proc]');
  check('A: tombol Proses tersedia', !!procBtn);
  procBtn.click(); await sleep(900);
  check('A: request dimuat (meta dari server + gambar di-decode)', KS.state.currentReqId === row1.id && KS.state.signMeta.cid === 'KTR-REQ-001' && KS.state.card.bytes.length === reqBytes.length);
  check('A: tombol Approve aktif saat permintaan dimuat', $('btnSign').disabled === false);
  const sigBytesM = new Uint8Array(611).map((_, i) => (i * 17 + 3) & 0xff);
  await D.loadImageFile(new winA.File([sigBytesM], 'ttd-manager.png', { type: 'image/png' }), 'sig');
  check('A: tanda tangan manager (PNG) dimuat utk dilampirkan', !!KS.state.sigImg && KS.state.sigImg.bytes.length === 611);
  $('btnSign').click(); await sleep(1800);
  check('A: status di server → disetujui + payload tersimpan', row1.status === 'disetujui' && row1.payload.length > 50 && row1.signed_by === 'boss');
  const pObj = JSON.parse(row1.payload);
  check('A: payload memakai data user (cid/hld/exp)', pObj.cid === 'KTR-REQ-001' && pObj.hld === 'Siti Aminah' && pObj.exp === '2027-12-31');
  check('A: payload VALID terhadap gambar yang dikirim user', (await KS.verify(pubPem, row1.payload, reqBytes)).valid === true);
  check('A: tanda tangan manager terikat (sh) + ringkasannya di QR (ss)', typeof pObj.sh === 'string' && pObj.sh.length === 43 && typeof pObj.ss === 'string');
  check('A: PNG tanda tangan dilampirkan ke approval (_sig di server)', !!row1.card_data._sig && Buffer.from(row1.card_data._sig, 'base64').length === 611);
  check('A: nama penyetuju ikut dilampirkan (_sname)', row1.card_data._sname === 'Budi Bos Besar');
  { const qd = $('qrDraft'); check('A: draft barcode (QR) tampil di panel manager', qd && !qd.classList.contains('hide') && qd.width > 300 && $('qrDraftEmpty').classList.contains('hide') && $('payloadBox').value === row1.payload, 'w=' + (qd && qd.width)); }
  check('A: chip status = di-approve & tombol approve terkunci lagi', /di-approve/.test($('chipSig').textContent) && $('btnSign').disabled === true);
  const payBtn = docA.querySelector('#queueBody [data-pay]');
  if (payBtn) { payBtn.click(); await sleep(200); }
  check('A: tombol Payload memuat QR ke tab verifikasi', $('vPayload').value === row1.payload);
  docA.querySelector('nav.tabs button[data-tab="history"]').click(); await sleep(400);
  check('A: riwayat server memuat KTR-REQ-001', /KTR-REQ-001/.test($('histBody').textContent) && KS.state.history.length >= 1);
  docA.querySelector('nav.tabs button[data-tab="approve"]').click(); await sleep(150);

  /* ============ 11. PERANGKAT B melihat hasil + penolakan ============ */
  await DB.renderMyRequests();
  check('B: siti melihat status disetujui + tombol Salin QR', /disetujui/.test($B('myReqBody').textContent) && /Salin QR/.test($B('myReqBody').textContent));
  const dlBtn = docB.querySelector('#myReqBody [data-dl]');
  check('B: tombol "Unduh Kartu" muncul utk pengajuan disetujui', !!dlBtn);
  dlBtn.click(); await sleep(1000);
  check('B: kartu dirender di perangkat user (canvas + info)', !$B('approvedBox').classList.contains('hide') && $B('approvedCanvas').width === 800 && /Siti Aminah/.test($B('approvedInfo').textContent) && /boss/.test($B('approvedInfo').textContent));
  check('B: payload direkonstruksi utuh dari server', KSB.state.sig && KSB.state.sig.payload === row1.payload);
  check('B: tanda tangan manager TIDAK dicetak ke kartu (sigImg null)', KSB.state.sigImg === null);
  check('B: gambar kartu asli dipulihkan (900 byte)', KSB.state.card.bytes.length === reqBytes.length);
  check('B: kontrol penempatan QR tersedia di panel user', !!$B('qrPos') && !!$B('qrSize') && !!$B('qrRotate') && !!$B('qrCaption'));
  check('B: caption bawah barcode = "Digitaly Signed - Nama manager"', $B('qrCaption').value === 'Digitaly Signed - Budi Bos Besar', $B('qrCaption').value);
  const capB = DB.computeBadge();
  check('B: caption nama ikut digambar ke badge', capB.caption === 'Digitaly Signed - Budi Bos Besar' && capB.capH > 0 && capB.capLines.join(' ').includes('Budi Bos Besar'));
  $B('qrPos').value = 'tl'; $B('qrPos').dispatchEvent(new winB.Event('change')); await sleep(200);
  const bB = DB.computeBadge();
  check('B: user memindahkan QR ke kiri-atas (drag/preset)', bB.fx < KSB.state.card.w / 2 && bB.fy < KSB.state.card.h / 2, 'fx=' + bB.fx + ' fy=' + bB.fy);
  const realErrs = () => errors.filter(e => !/Not implemented|Could not parse CSS/i.test(e));
  const nErrBefore = realErrs().length;
  $B('btnUserDlPng').click(); await sleep(250);
  $B('btnUserDlQr').click(); await sleep(250);
  check('B: unduh PNG & QR tidak menghasilkan error', realErrs().length === nErrBefore, realErrs().slice(nErrBefore).join('|').slice(0,200));
  $B('mCardId').value = 'KTR-REQ-002'; $B('mHolder').value = 'Uji Tolak';
  $B('btnSubmitReq').click(); await sleep(800);
  const row2 = backend.requests.find(r => (r.card_data || {}).cid === 'KTR-REQ-002');
  check('B: pengajuan kedua terkirim', !!row2 && row2.status === 'menunggu');
  await D.renderQueue();
  winA.__promptQueue.push('Data tidak lengkap');
  const rejBtn = [...docA.querySelectorAll('#queueBody [data-rej]')].pop();
  rejBtn.click(); await sleep(700);
  check('A: manager menolak → status ditolak + catatan di server', row2.status === 'ditolak' && row2.note === 'Data tidak lengkap');
  await DB.renderMyRequests();
  check('B: siti melihat penolakan + catatannya', /ditolak/.test($B('myReqBody').textContent) && /Data tidak lengkap/.test($B('myReqBody').textContent));

  /* ============ 12. RLS: user tidak bisa bertindak sebagai manager ============ */
  const SBB = DB.SB;
  const rowsSeen = await SBB.listRequests();
  check('RLS: user hanya melihat pengajuannya sendiri', rowsSeen.length === 2 && rowsSeen.every(r => r.created_by === SBB.userId), 'rows=' + rowsSeen.length);
  let rlsUpdate = false;
  try { await SBB.updateRequest(row1.id, { status: 'ditolak' }); } catch (e) { rlsUpdate = /row-level security|violates/i.test(e.message); }
  check('RLS: user mengubah status → ditolak policy', rlsUpdate);
  let rlsKey = false;
  try { await SBB.saveKey({ key_id: 'ES256', alg: 'ES256', kid: 'palsu', pubkey_pem: 'x', priv_enc: 'x', locked: false, created_by: SBB.userId }); } catch (e) { rlsKey = /row-level security|violates/i.test(e.message); }
  check('RLS: user menyimpan kunci → ditolak policy', rlsKey);
  let rlsRole = false;
  try { await SBB.updateProfile(SBB.userId, { role: 'manager' }); } catch (e) { rlsRole = /row-level security|violates/i.test(e.message); }
  check('RLS: user menaikkan role sendiri → ditolak (manager sudah ada)', rlsRole);
  const profsSeen = await SBB.listProfiles();
  check('RLS: daftar username terbaca oleh user (utk tampilan)', profsSeen.length >= 3);

  /* ============ 13. MANAJEMEN AKUN: nonaktifkan + login ditolak ============ */
  docA.querySelector('nav.tabs button[data-tab="keys"]').click(); await sleep(150);
  await D.renderAccounts();
  const sitiRow = backend.profiles.find(p => p.username === 'siti');
  const deactBtn = docA.querySelector('[data-act-toggle][data-uname="siti"]');
  check('A: tombol Nonaktifkan tersedia utk akun lain', !!deactBtn);
  deactBtn.click(); await sleep(600);
  check('A: siti dinonaktifkan di server', sitiRow.active === false && /nonaktif/.test($('accBody').textContent));
  $B('btnLogout').click(); await sleep(500);
  $B('liUser').value = 'siti'; $B('liPass').value = 'siti12345';
  $B('btnLogin').click(); await sleep(700);
  check('B: akun nonaktif tidak bisa login', /dinonaktifkan/i.test($B('liErr').textContent), $B('liErr').textContent);
  const actBtn = docA.querySelector('[data-act-toggle][data-uname="siti"]');
  actBtn.click(); await sleep(600);
  check('A: siti diaktifkan kembali', sitiRow.active === true);
  $B('btnLogin').click(); await sleep(800);
  DB.stopPolling();
  check('B: siti bisa login lagi', /level 1/.test($B('chipSession').textContent));

  /* ============ 14. GANTI PASSWORD (server) + re-wrap kunci ============ */
  winA.__promptQueue.push('boss12345', 'newpass123', 'newpass123');
  $('btnChangePass').click(); await sleep(2500);
  check('Password boss berubah di server', backend.users.find(u => u.username === 'boss').password === 'newpass123');
  const keyRow2 = backend.signing_keys.find(r => r.key_id === 'ES256');
  let rewrap = false;
  try { rewrap = !!(await D.decryptBlob(JSON.parse(keyRow2.priv_enc).payload, 'newpass123')); } catch (e) {}
  check('Kunci di server dibungkus ulang dgn password baru', rewrap);
  let oldFails = false;
  try { await D.decryptBlob(JSON.parse(keyRow2.priv_enc).payload, 'boss12345'); } catch (e) { oldFails = true; }
  check('Password lama tidak bisa membuka kunci lagi', oldFails);

  /* ============ 15. PERANGKAT C: manager login di perangkat lain ============ */
  const domC = makeDom(html, seedConfig);
  const winC = domC.window, docC = winC.document;
  await sleep(500);
  const KSC = winC.KartuSign, DC = KSC._debug, $C = (id) => docC.getElementById(id);
  $C('liUser').value = 'boss'; $C('liPass').value = 'boss12345';
  $C('btnLogin').click(); await sleep(700);
  check('C: password lama ditolak setelah ganti', /salah/.test($C('liErr').textContent));
  $C('liPass').value = 'newpass123';
  $C('btnLogin').click(); await sleep(2500);
  DC.stopPolling();
  check('C: manager login di perangkat baru → level 2', /level 2/.test($C('chipSession').textContent));
  const keyStateC = Object.fromEntries(Object.entries(KSC.state.keys).map(([k,v])=>[k, v ? (v.locked ? 'locked' : (v.privateKey ? 'ok' : 'partial')) : 'null']));
  check('C: kunci privat otomatis terbuka (password sesi) → siap tanda tangan', !!KSC.state.keys.ES256 && !!KSC.state.keys.ES256.privateKey && KSC.state.keys.ES256.kid === kidES, JSON.stringify(keyStateC));
  check('C: antrean server langsung terlihat', /KTR-REQ-001/.test($C('queueBody').textContent));
  $B('mCardId').value = 'KTR-REQ-C'; $B('mHolder').value = 'Dari Perangkat C';
  $B('btnSubmitReq').click(); await sleep(900);
  const rowC = backend.requests.find(r => (r.card_data || {}).cid === 'KTR-REQ-C');
  check('B: pengajuan baru terkirim (utk diapprove perangkat C)', !!rowC && rowC.status === 'menunggu');
  await DC.renderQueue();
  const procC = [...docC.querySelectorAll('#queueBody [data-proc]')].find(b => b.dataset.proc === rowC.id);
  check('C: permintaan baru muncul di antrean perangkat C', !!procC);
  procC.click(); await sleep(900);
  $C('btnSign').click(); await sleep(1500);
  check('C: approve dari perangkat lain → disetujui + payload di server', rowC.status === 'disetujui' && rowC.payload.length > 50 && rowC.signed_by === 'boss');
  check('C: payload valid terhadap gambarnya', (await KSC.verify($C('pubPem').value.trim(), rowC.payload, reqBytes)).valid === true);
  await D.renderQueue();
  check('A: hasil perangkat C terlihat di perangkat A', /KTR-REQ-C/.test($('queueBody').textContent));

  /* ============ 16. PERANGKAT D: restore sesi otomatis (tanpa login ulang) ============ */
  const savedSes = winC.localStorage.getItem('kartusign.sb.session.v1');
  const domD = makeDom(html, (w) => { seedConfig(w); w.localStorage.setItem('kartusign.sb.session.v1', savedSes); });
  const winD = domD.window, docD = winD.document;
  await sleep(1600);
  winD.KartuSign._debug.stopPolling();
  check('D: sesi dipulihkan otomatis → langsung masuk sebagai boss', /boss/.test(docD.getElementById('chipSession').textContent) && !panel(winD, 'approve').classList.contains('hide'));

  /* ============ 17. VERIFIER BUILD (offline, kunci tertanam) ============ */
  const vhtml = D.buildVerifierHtml();
  check('Verifier build memuat kunci tertanam', vhtml.includes('"kid":"' + kidES + '"'));
  check('Verifier build satu file utuh', vhtml.startsWith('<!DOCTYPE html>') && vhtml.includes('TRUST_STORE = [{'));
  const dom2 = makeDom(vhtml);
  await sleep(700);
  const d2 = dom2.window.document;
  check('Verifier: langsung buka tab Verifikasi (tanpa setup/login)', !d2.querySelector('[data-panel="verify"]').classList.contains('hide') && d2.querySelector('[data-panel="setup"]').classList.contains('hide') && d2.querySelector('[data-panel="login"]').classList.contains('hide'));
  check('Verifier: badge header mode verifier', /Mode Verifier/.test(d2.querySelector('.brand .badge').textContent));
  d2.getElementById('vPayload').value = row1.payload;
  d2.getElementById('btnVerify').click(); await sleep(900);
  check('Verifier: payload request siti → ✓ ASLI (kunci tertanam)', /✓ KARTU INI ASLI/.test(d2.getElementById('vResult').textContent), d2.getElementById('vResult').textContent.slice(0, 80).replace(/\s+/g, ' '));
  check('Verifier offline: tanda tangan manager tampil di hasil (dari ss)', /<img/.test(d2.getElementById('vResult').innerHTML) && /Tanda tangan manager/.test(d2.getElementById('vResult').innerHTML));
  const forg2 = JSON.parse(row1.payload); forg2.cid = 'KTR-PALSU-999';
  d2.getElementById('vPayload').value = JSON.stringify(forg2);
  d2.getElementById('btnVerify').click(); await sleep(700);
  check('Verifier: payload dipalsukan → ✗ TIDAK ASLI', /✗ KARTU TIDAK ASLI/.test(d2.getElementById('vResult').textContent));

  /* ============ 18. TANDA TANGAN BASAH (sh/ss) — port v3 ============ */
  docA.querySelector('nav.tabs button[data-tab="approve"]').click(); await sleep(150);
  KS.state.card = { file: null, name: 'kartu-uji.png', img: { naturalWidth: 800, naturalHeight: 500 }, bytes: imgBytes, w: 800, h: 500 };
  KS.state.currentReqId = null; KS.state.signMeta = null;
  const sigBytes = new Uint8Array(777).map((_, i) => (i * 31 + 7) & 0xff);
  await D.loadImageFile(new winA.File([sigBytes], 'ttd-budi.png', { type: 'image/png' }), 'sig');
  check('File tanda tangan PNG dimuat', !!KS.state.sigImg && KS.state.sigImg.bytes.length === 777);
  D.render(); D.renderSigInfo();
  const sEmb = await D.signCard();
  const pEmb = JSON.parse(sEmb.payload);
  check('Tanda tangan dilampirkan → sh + ss OTOMATIS di payload', pEmb.v === 3 && typeof pEmb.sh === 'string' && pEmb.sh.length === 43 && typeof pEmb.ss === 'string' && JSON.parse(pEmb.ss).w === 96);
  const ssStr = await D.buildCompactSig(KS.state.sigImg.img, 96, 40);
  const urlBack = await D.expandCompactSig(ssStr);
  check('Round-trip compact sig → data URL PNG', typeof urlBack === 'string' && urlBack.startsWith('data:image/png'));
  check('Payload ber-ss VALID via API', (await KS.verify(pubPem, sEmb.payload, imgBytes)).valid === true);
  const tamSh = JSON.parse(sEmb.payload); tamSh.sh = 'B'.repeat(43);
  check('sh diubah → TIDAK VALID', (await KS.verify(pubPem, JSON.stringify(tamSh), imgBytes)).valid === false);
  KS.state.sigImg = null;

  /* ============ 18b. TANDA TANGAN BASAH: manager pakai, user mengunduh ============ */
  await D.loadImageFile(new winA.File([sigBytes], 'ttd-budi.png', { type: 'image/png' }), 'sig');
  $B('mCardId').value = 'KTR-REQ-003'; $B('mHolder').value = 'Ttd Basah';
  $B('btnSubmitReq').click(); await sleep(900);
  const row3 = backend.requests.find(r => (r.card_data || {}).cid === 'KTR-REQ-003');
  check('B: pengajuan ke-3 terkirim', !!row3 && row3.status === 'menunggu');
  await D.renderQueue();
  const proc3 = [...docA.querySelectorAll('#queueBody [data-proc]')].find(b => b.dataset.proc === row3.id);
  check('A: permintaan ke-3 muncul di antrean', !!proc3);
  proc3.click(); await sleep(900);
  $('btnSign').click(); await sleep(1600);
  check('A: approval menyimpan PNG tanda tangan (_sig) + ss di payload', row3.status === 'disetujui' && !!(row3.card_data || {})._sig && Buffer.from(row3.card_data._sig, 'base64').length === 777 && 'ss' in JSON.parse(row3.payload));
  await DB.renderMyRequests();
  const dl3 = [...docB.querySelectorAll('#myReqBody [data-dl]')].find(b => b.dataset.dl === row3.id);
  dl3.click(); await sleep(1100);
  check('B: kartu dirender TANPA tanda tangan di atasnya (sigImg null)', KSB.state.sigImg === null);
  check('B: payload REQ-003 valid terhadap gambarnya', (await KSB.verify(pubPem, row3.payload, reqBytes)).valid === true);
  check('B: canvas kartu ke-3 dirender', $B('approvedCanvas').width === 800 && /Ttd Basah/.test($B('approvedInfo').textContent));
  $B('vPayload').value = row3.payload; $B('vKey').value = '';
  docB.querySelector('nav.tabs button[data-tab="verify"]').click();
  $B('btnVerify').click(); await sleep(1100);
  check('B: verifikasi → PNG tanda tangan manager tampil di hasil (asli, dari server)', /✓ KARTU INI ASLI/.test($B('vResult').textContent) && /tanda tangan PNG manager/.test($B('vResult').innerHTML), $B('vResult').textContent.slice(0, 70).replace(/\s+/g, ' '));
  docB.querySelector('nav.tabs button[data-tab="request"]').click(); await sleep(100);

  /* ============ 19. KOMPAT v2 + payload ringkas ============ */
  const kp2 = await KS.keys.generate('ES256');
  const hImg = KS.utils.b64u(await winA.crypto.subtle.digest('SHA-256', imgBytes));
  const baseV2 = { v: 2, alg: 'ES256', kid: kp2.kid, ts: Math.floor(Date.now() / 1000), cid: 'V2-LEGACY', hld: 'Kartu Lama', apr: 'Admin', exp: '', rsn: '', h: hImg };
  const csV2 = D.canonicalString(baseV2);
  const dig2 = await winA.crypto.subtle.digest('SHA-256', new winA.TextEncoder().encode(csV2));
  const sig2 = await winA.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp2.privateKey, dig2);
  const payloadV2 = JSON.stringify({ ...baseV2, s: KS.utils.b64u(sig2) });
  check('Payload v2 lama tetap VALID (kunci manual)', (await KS.verify(kp2.publicPem, payloadV2, imgBytes)).valid === true);
  KS.state.card = { file: null, name: 'kartu-uji.png', img: { naturalWidth: 800, naturalHeight: 500 }, bytes: imgBytes, w: 800, h: 500 };
  KS.state.signMeta = null; KS.state.currentReqId = null; KS.state.sigImg = null;
  $('mReason').value = ''; $('mValid').value = '';
  $('mReason').dispatchEvent(new winA.Event('input')); await sleep(80);
  D.render(); D.renderSigInfo();
  const sCompact = await D.signCard();
  const pC = JSON.parse(sCompact.payload);
  check('Field opsional kosong dibuang dari payload', !('rsn' in pC) && !('exp' in pC), Object.keys(pC).join(','));
  check('Payload ringkas tetap VALID', (await KS.verify(pubPem, sCompact.payload, imgBytes)).valid === true);
  $('qrShortKid').checked = true;
  const sShort = await D.signCard();
  check('Key ID ringkas = 6 karakter + tetap VALID', JSON.parse(sShort.payload).kid.length === 6 && (await KS.verify(pubPem, sShort.payload, imgBytes)).valid === true);
  $('qrShortKid').checked = false;
  const cv = KS.render(1);
  check('Render kartu menghasilkan canvas', !!cv && cv.width === 800);

  /* ============ 19b. PROFIL: ganti nama lengkap sendiri (RPC server) ============ */
  winA.__promptQueue.push('Budi Bos Baru');
  $('btnChangeName').click(); await sleep(500);
  check('A: ganti nama sendiri → tersimpan di server + sesi + chip', backend.profiles.find(p => p.username === 'boss').full_name === 'Budi Bos Baru' && KS.state.session.fullName === 'Budi Bos Baru' && /Budi Bos Baru/.test($('chipSession').textContent));
  winA.__promptQueue.push('X');
  $('btnChangeName').click(); await sleep(300);
  check('A: nama < 2 karakter ditolak', KS.state.session.fullName === 'Budi Bos Baru' && backend.profiles.find(p => p.username === 'boss').full_name === 'Budi Bos Baru');

  /* ============ 20. LOGOUT membersihkan state lokal ============ */
  await D.logout(); await sleep(300);
  check('Logout → panel login, kunci memori dibersihkan', !panel(winA, 'login').classList.contains('hide') && !KS.state.keys.ES256 && !winA.localStorage.getItem('kartusign.sb.session.v1'));

  /* ============ REPORT ============ */
  let pass = 0;
  console.log('\n=== HASIL UJI KARTUSIGN (SUPABASE) ===');
  for (const r of results) {
    console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
    if (r.ok) pass++;
  }
  console.log(`\n${pass}/${results.length} lolos`);
  const realErrors = errors.filter(e => !/Not implemented|Could not parse CSS/i.test(e));
  if (realErrors.length) { console.log('\nError runtime:'); realErrors.slice(0, 6).forEach(e => console.log(' - ' + e.slice(0, 300))); }
  process.exit(pass === results.length && realErrors.length === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
