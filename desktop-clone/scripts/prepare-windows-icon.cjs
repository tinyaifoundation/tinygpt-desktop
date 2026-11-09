// Encode the existing artwork in Windows' multi-resolution ICO container.
const { app, nativeImage } = require('electron');
const { resolve } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
app.setPath('userData', resolve('artifacts/icon-build-profile'));
app.whenReady().then(() => {
  const image = nativeImage.createFromPath(resolve('src/main/assets/dock-icons/tinygpt-ios-default.png'));
  if (image.isEmpty()) throw Error('TinyGPT icon artwork is missing.');
  const sizes = [16, 24, 32, 48, 64, 128, 256], frames = sizes.map(size => image.resize({ width: size, height: size, quality: 'best' }).toPNG());
  const header = Buffer.alloc(6 + frames.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4); let offset = header.length;
  frames.forEach((frame, index) => { const at = 6 + index * 16, size = sizes[index]; header[at] = header[at + 1] = size === 256 ? 0 : size; header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6); header.writeUInt32LE(frame.length, at + 8); header.writeUInt32LE(offset, at + 12); offset += frame.length; });
  mkdirSync(resolve('src/main/assets'), { recursive: true }); writeFileSync(resolve('src/main/assets/tinygpt.ico'), Buffer.concat([header, ...frames])); console.log('TinyGPT Windows icon encoded in seven sizes.'); app.quit();
}).catch(error => { console.error(error.message); app.exit(1); });
