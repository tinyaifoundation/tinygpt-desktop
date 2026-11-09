const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { mkdirSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const root = resolve(__dirname, '..');
function bitmap(canvas) {
  const { width, height } = canvas, stride = (width * 3 + 3) & ~3;
  const output = Buffer.alloc(54 + stride * height);
  output.write('BM'); output.writeUInt32LE(output.length, 2); output.writeUInt32LE(54, 10);
  output.writeUInt32LE(40, 14); output.writeInt32LE(width, 18); output.writeInt32LE(height, 22);
  output.writeUInt16LE(1, 26); output.writeUInt16LE(24, 28); output.writeUInt32LE(stride * height, 34);
  const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = (y * width + x) * 4, target = 54 + (height - 1 - y) * stride + x * 3;
    output[target] = pixels[source + 2]; output[target + 1] = pixels[source + 1]; output[target + 2] = pixels[source];
  }
  return output;
}
async function main() {
  mkdirSync(resolve(root, 'build'), { recursive: true });
  const logo = await loadImage(resolve(root, 'src/main/assets/dock-icons/tinygpt-ios-default.png'));
  const side = createCanvas(164, 314), s = side.getContext('2d');
  s.fillStyle = '#09585c'; s.fillRect(0, 0, 164, 314);
  s.fillStyle = '#e8f6b1'; s.font = '600 17px "Segoe UI"'; s.fillText('TinyGPT', 19, 40);
  s.drawImage(logo, 43, 98, 78, 78);
  s.fillStyle = '#e8f6b1'; s.font = '500 17px "Segoe UI"'; s.fillText('A little help', 19, 240); s.fillText('for every idea.', 19, 263);
  s.fillStyle = '#9bc4b1'; s.font = '10px "Segoe UI"'; s.fillText('tinygpt.org', 19, 300);
  writeFileSync(resolve(root, 'build/installer-sidebar.bmp'), bitmap(side));
  const header = createCanvas(150, 57), h = header.getContext('2d'); h.fillStyle = '#ffffff'; h.fillRect(0, 0, 150, 57);
  h.drawImage(logo, 12, 12, 33, 33); h.fillStyle = '#202124'; h.font = '600 18px "Segoe UI"'; h.fillText('TinyGPT', 53, 35);
  writeFileSync(resolve(root, 'build/installer-header.bmp'), bitmap(header));
  const dmg = createCanvas(660, 440), d = dmg.getContext('2d'); d.fillStyle = '#ffffff'; d.fillRect(0, 0, 660, 440);
  d.drawImage(logo, 282, 35, 32, 32); d.fillStyle = '#202124'; d.font = '600 22px "Segoe UI"'; d.fillText('TinyGPT', 323, 59);
  d.textAlign = 'center'; d.font = '400 17px "Segoe UI"'; d.fillText('A little help. A lot of possibility.', 330, 118);
  d.fillStyle = '#8b8e95'; d.font = '400 14px "Segoe UI"'; d.fillText('Drag TinyGPT into Applications to get started.', 330, 151);
  d.strokeStyle = '#c1c5cc'; d.lineWidth = 2; d.beginPath(); d.moveTo(293, 245); d.lineTo(365, 245); d.moveTo(356, 237); d.lineTo(365, 245); d.lineTo(356, 253); d.stroke();
  d.fillStyle = '#979ba2'; d.font = '400 12px "Segoe UI"'; d.fillText('tinygpt.org', 330, 396);
  writeFileSync(resolve(root, 'build/dmg-background.png'), dmg.toBuffer('image/png'));
  console.log('TinyGPT Windows installer artwork and Mac disk-image background prepared.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
