import pathlib

tpl = pathlib.Path("app.template.html").read_text(encoding="utf-8")
lib = pathlib.Path("qrcode-generator.js").read_text(encoding="utf-8")

wrapper = "window.qrcode = (function(){\n" + lib + "\nreturn (typeof qrcode !== 'undefined') ? qrcode : null;\n})();\n"
out = tpl.replace("/*QRGEN_LIB*/", wrapper).replace("/*QRGEN_CSS*/", "")

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
