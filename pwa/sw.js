/* =====================================================================
   Service Worker — Platform Cek Keaslian Kartu (PWA)
   - Asset halaman: cache-first → terbuka instan & tetap jalan offline
     setelah sekali dikunjungi.
   - Kunci publik penerbit (RPC public_signing_keys): network-first lalu
     disimpan ke cache → bila offline, VERIFIKASI KEASLIAN TETAP JALAN
     memakai kunci yang terakhir tersimpan.
   Nama cache distempel build.py sesuai versi rilis (mengganti __CACHE_VER__).
   ===================================================================== */
const CACHE = "cek-__CACHE_VER__";
const KEYS_URL = new URL("/__public_signing_keys__", self.location.origin).href;
const ASSETS = ["cek-keaslian.html", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(ASSETS.map((a) => c.add(a).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }

  /* Kunci publik penerbit: network-first, fallback cache (verifikasi offline) */
  if (url.pathname.endsWith("/rpc/public_signing_keys")) {
    e.respondWith(
      fetch(req).then((r) => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(KEYS_URL, copy));
        }
        return r;
      }).catch(() =>
        caches.open(CACHE)
          .then((c) => c.match(KEYS_URL))
          .then((hit) => hit || new Response('{"offline":true}', {
            status: 503,
            headers: { "Content-Type": "application/json" }
          }))
      )
    );
    return;
  }

  if (req.method !== "GET") return;

  /* Navigasi halaman: jaringan dulu, fallback halaman ter-cache saat offline */
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).catch(() => caches.open(CACHE).then((c) => c.match("cek-keaslian.html")))
    );
    return;
  }

  /* Asset asal yang sama: cache-first + penyegaran di latar */
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.open(CACHE).then((c) =>
        c.match(req).then((hit) => {
          const net = fetch(req).then((r) => {
            if (r.ok) c.put(req, r.clone());
            return r;
          }).catch(() => hit);
          return hit || net;
        })
      )
    );
  }
});
