import { createCanvas } from '@napi-rs/canvas';
import { deflateSync } from 'node:zlib';
export function invoiceImage() { const canvas = createCanvas(1200, 260), context = canvas.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, 1200, 260); context.fillStyle = 'black'; context.font = 'bold 72px Arial'; context.fillText('INVOICE TOTAL 4287', 50, 150); return canvas; }
export function scannedPdf() {
  const canvas = invoiceImage(), pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, rgb = Buffer.alloc(canvas.width * canvas.height * 3);
  for (let i = 0, j = 0; i < pixels.length; i += 4) { rgb[j++] = pixels[i]; rgb[j++] = pixels[i + 1]; rgb[j++] = pixels[i + 2]; }
  const image = deflateSync(rgb), commands = Buffer.from('q 600 0 0 130 0 0 cm /Im0 Do Q');
  const objects = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'), Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 130] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'), Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`), image, Buffer.from('\nendstream')]), Buffer.concat([Buffer.from(`<< /Length ${commands.length} >>\nstream\n`), commands, Buffer.from('\nendstream')])];
  const parts = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let length = parts[0].length;
  objects.forEach((object, i) => { offsets.push(length); const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]); parts.push(part); length += part.length; });
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`)); return Buffer.concat(parts);
}
