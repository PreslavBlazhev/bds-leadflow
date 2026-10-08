// Генерира ВРЕМЕННА PNG иконка (BDS monogram, pixel font) без външни библиотеки. Не е официално лого.
import fs from "node:fs";
import zlib from "node:zlib";

const FONT = {
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
};
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const bg = [0x08, 0x11, 0x1f], fg = [0x3b, 0x82, 0xf6], tx = [0xf8, 0xfa, 0xfc];
  const px = Buffer.alloc(size * size * 3);
  const r = Math.round(size * 0.12), pad = Math.round(size * 0.08);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const inside = x >= pad && x < size - pad && y >= pad && y < size - pad;
    const cx = Math.min(x - pad, size - pad - 1 - x), cy = Math.min(y - pad, size - pad - 1 - y);
    const corner = cx < r && cy < r && (r - cx) ** 2 + (r - cy) ** 2 > r * r;
    const c = inside && !corner ? fg : bg;
    px.set(c, (y * size + x) * 3);
  }
  const letters = "BDS", cell = Math.floor(size / 22), w = letters.length * 6 * cell - cell, h = 7 * cell;
  const ox = Math.floor((size - w) / 2), oy = Math.floor((size - h) / 2);
  [...letters].forEach((ch, li) => FONT[ch].forEach((row, ry) => [...row].forEach((bit, rx) => {
    if (bit !== "1") return;
    for (let yy = 0; yy < cell; yy++) for (let xx = 0; xx < cell; xx++) {
      const X = ox + (li * 6 + rx) * cell + xx, Y = oy + ry * cell + yy;
      px.set(tx, (Y * size + X) * 3);
    }
  })));
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 3 + 1)] = 0; px.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
fs.mkdirSync("public/icons", { recursive: true });
for (const s of [192, 512]) fs.writeFileSync(`public/icons/icon-${s}.png`, png(s));
console.log("icons ok");
