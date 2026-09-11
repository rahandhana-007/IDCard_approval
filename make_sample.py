from PIL import Image, ImageDraw, ImageFont
import os

# Kartu contoh format POTRET — ID-1 diputar: 54 x 85.6 mm @300dpi
W, H = 638, 1012

def font(size, bold=False):
    cands = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for c in cands:
        if os.path.exists(c):
            return ImageFont.truetype(c, size)
    return ImageFont.load_default()

img = Image.new("RGB", (W, H), "#ffffff")
d = ImageDraw.Draw(img)

for y in range(H):
    t = y / H
    d.line([(0, y), (W, y)], fill=(int(248+(232-248)*t), int(250+(240-250)*t), int(252+(250-252)*t)))

# header
d.rectangle([0, 0, W, 150], fill="#1e3a8a")
d.rectangle([0, 150, W, 160], fill="#f59e0b")
d.text((36, 26), "PEMERINTAH PROVINSI", font=font(24, True), fill="#ffffff")
d.text((36, 58), "SUMATERA UTARA", font=font(28, True), fill="#ffffff")
d.text((36, 98), "DINAS KEPENDUDUKAN & PENERBITAN KARTU", font=font(16), fill="#bfdbfe")
d.text((36, 122), "CONTOH — BUKAN DOKUMEN RESMI", font=font(14, True), fill="#fca5a5")
d.rounded_rectangle([W-116, 30, W-36, 110], radius=12, outline="#fbbf24", width=4)
d.text((W-101, 52), "SUMUT", font=font(20, True), fill="#fbbf24")

# foto
px, py, pw, ph = 36, 196, 200, 250
d.rounded_rectangle([px, py, px+pw, py+ph], radius=10, fill="#e2e8f0", outline="#94a3b8", width=3)
d.ellipse([px+60, py+38, px+140, py+118], fill="#cbd5e1")
d.pieslice([px+30, py+126, px+170, py+266], 180, 360, fill="#cbd5e1")
d.text((px+56, py+ph-32), "FOTO 3x4", font=font(16, True), fill="#64748b")

# blok kanan foto: identitas singkat
x0 = px + pw + 30
d.text((x0, py+8),  "NAMA", font=font(15, True), fill="#64748b")
d.text((x0, py+30), "BUDI SANTOSO, S.T.", font=font(22, True), fill="#0f172a")
d.text((x0, py+76), "NOMOR KARTU", font=font(15, True), fill="#64748b")
d.text((x0, py+98), "KTR-2026-000123", font=font(22, True), fill="#0f172a")
d.text((x0, py+144), "GOL. DARAH", font=font(15, True), fill="#64748b")
d.text((x0, py+166), "O", font=font(22, True), fill="#0f172a")
d.text((x0+150, py+144), "MASA BERLAKU", font=font(15, True), fill="#64748b")
d.text((x0+150, py+166), "31-12-2027", font=font(22, True), fill="#0f172a")

# data rinci
y0 = py + ph + 44
rows = [
    ("JABATAN", "ANALIS KEBIJAKAN AHLI MUDA"),
    ("UNIT KERJA", "BIRO UMUM & PENGADAAN"),
    ("ALAMAT", "JL. DIPONEGORO NO. 30, MEDAN"),
]
for i, (k, v) in enumerate(rows):
    yy = y0 + i * 66
    d.text((36, yy), k, font=font(15, True), fill="#64748b")
    d.text((36, yy + 22), v, font=font(21, True), fill="#0f172a")
    d.line([(36, yy + 54), (W - 36, yy + 54)], fill="#dbe3ee", width=2)

# area kosong kanan-bawah untuk QR hasil KartuSign
d.text((36, H - 150), "Area tanda tangan digital (QR)", font=font(15), fill="#94a3b8")
d.text((36, H - 128), "ditempelkan otomatis oleh aplikasi", font=font(15), fill="#94a3b8")

# footer
d.rectangle([0, H - 76, W, H], fill="#0f172a")
d.text((36, H - 56), "KARTU TANDA PENGENAL PEGAWAI", font=font(16, True), fill="#e2e8f0")
d.text((36, H - 32), "WAJIB DIBAWA SELAMA BERTUGAS", font=font(13), fill="#94a3b8")

img.save("contoh-kartu.png", "PNG", dpi=(300, 300))
print("contoh-kartu.png POTRET", img.size, os.path.getsize("contoh-kartu.png"), "bytes")
