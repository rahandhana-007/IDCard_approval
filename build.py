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

print("OK ->", main, len(out), "bytes")
print("OK ->", prev / "index.html")
