// Uji: payload nyata -> matriks QR -> decode ulang (tanpa canvas)
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'qrcode-generator.js'), 'utf8');
const qrcode = new Function(src + '\n; return qrcode;')();
const jsQR = require('jsqr').default || require('jsqr');

const payload = JSON.stringify({
  v:1, alg:"ES256", kid:"d6a67cbf4c1b", ts:1767225600,
  cid:"KTR-2026-000123", hld:"BUDI SANTOSO, S.T.", apr:"Kepala Divisi SDM",
  exp:"2027-12-31", h:"8Gk1yT0vQ4rLmZpXnB2wCdEfGhIjKlMnOpQrStUvWxY",
  s:"MEUCIQDx1a2b3c4d5e6f7g8h9i0jklmnopqrstuvwxyzABCDEFGH"
});

let fails = 0;
for (const ecl of ["L","M","Q","H"]) {
  const qr = qrcode(0, ecl);
  qr.addData(payload, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 2, total = n + quiet*2, cell = 6;
  const size = total*cell;
  const data = new Uint8ClampedArray(size*size*4).fill(255);
  for (let r=0;r<n;r++) for (let c=0;c<n;c++){
    if (!qr.isDark(r,c)) continue;
    for (let y=0;y<cell;y++) for (let x=0;x<cell;x++){
      const px=(c+quiet)*cell+x, py=(r+quiet)*cell+y;
      const i=(py*size+px)*4; data[i]=0;data[i+1]=0;data[i+2]=0;data[i+3]=255;
    }
  }
  const res = jsQR(data, size, size);
  const ok = res && res.data === payload;
  if (!ok) fails++;
  console.log(`${ok?'PASS':'FAIL'}  ECL ${ecl} | versi ${((n-17)/4).toString().padStart(2)} | modul ${n} | ukuran cetak minimum ${ (n*0.33).toFixed(0) } mm | decode ${ok?'cocok':'GAGAL'}`);
}
console.log(fails === 0 ? "\nSemua level koreksi galat lolos decode." : `\n${fails} gagal`);
process.exit(fails===0?0:1);
