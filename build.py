import pathlib

tpl = pathlib.Path("app.template.html").read_text(encoding="utf-8")
lib = pathlib.Path("qrcode-generator.js").read_text(encoding="utf-8")

wrapper = "window.qrcode = (function(){\n" + lib + "\nreturn (typeof qrcode !== 'undefined') ? qrcode : null;\n})();\n"
out = tpl.replace("/*QRGEN_LIB*/", wrapper).replace("/*QRGEN_CSS*/", "")

# koneksi Supabase tertanam (opsional): env SB_URL/SB_KEY atau supabase/config.json
import os, json
_sb_url = os.environ.get("SB_URL", ""); _sb_key = os.environ.get("SB_KEY", "")
if not (_sb_url and _sb_key):
    try:
        _c = json.loads(pathlib.Path("supabase/config.json").read_text(encoding="utf-8"))
        _sb_url, _sb_key = _c.get("url", ""), _c.get("key", "")
    except Exception:
        pass
out = out.replace('"/*SB_URL*/"', json.dumps(_sb_url)).replace('"/*SB_KEY*/"', json.dumps(_sb_key))
if _sb_url: print("   (koneksi Supabase tertanam di build)")

main = pathlib.Path("KartuSign.html")
main.write_text(out, encoding="utf-8")

# salinan untuk pratinjau server lokal
prev = pathlib.Path("preview")
prev.mkdir(exist_ok=True)
(prev / "index.html").write_text(out, encoding="utf-8")

# salinan untuk deploy Netlify (folder deploy/ sudah berisi netlify.toml & contoh kartu)
dep = pathlib.Path("deploy")
dep.mkdir(exist_ok=True)
(dep / "index.html").write_text(out, encoding="utf-8")

# platform cek keaslian (standalone, tanpa login) — koneksi tertanam sama
cek_tpl = pathlib.Path("cek.template.html")
if cek_tpl.exists():
    cek = cek_tpl.read_text(encoding="utf-8")
    cek = cek.replace('"/*SB_URL*/"', json.dumps(_sb_url)).replace('"/*SB_KEY*/"', json.dumps(_sb_key))
    _jsqr = pathlib.Path("jsqr.js")
    assert _jsqr.exists(), "jsqr.js tidak ditemukan — library decoder QR untuk platform cek"
    cek = cek.replace("/*JSQR_LIB*/", _jsqr.read_text(encoding="utf-8"))
    pathlib.Path("CekKeaslian.html").write_text(cek, encoding="utf-8")
    (prev / "cek-keaslian.html").write_text(cek, encoding="utf-8")
    (dep / "cek-keaslian.html").write_text(cek, encoding="utf-8")
    import re, shutil
    _mver = re.search(r"Cek Keaslian Kartu (v[0-9.]+)", cek)
    _cver = _mver.group(1) if _mver else "dev"
    _pwa = pathlib.Path("pwa")
    if _pwa.exists():
        for _t in (prev, dep):
            (_t / "manifest.webmanifest").write_text((_pwa / "manifest.webmanifest").read_text(encoding="utf-8"), encoding="utf-8")
            (_t / "sw.js").write_text((_pwa / "sw.js").read_text(encoding="utf-8").replace("__CACHE_VER__", _cver), encoding="utf-8")
            for _ic in ("icon-192.png", "icon-512.png"):
                if (_pwa / _ic).exists(): shutil.copyfile(_pwa / _ic, _t / _ic)
        print("OK -> PWA (manifest, sw.js cache " + _cver + ", ikon) ke preview/ & deploy/")
    print("OK -> CekKeaslian.html", len(cek), "bytes (+ preview/ & deploy/ cek-keaslian.html)")

print("OK ->", main, len(out), "bytes")
print("OK ->", prev / "index.html")
