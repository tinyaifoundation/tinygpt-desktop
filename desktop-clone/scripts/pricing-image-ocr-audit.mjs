// Read-only reproduction of the user-authorized image audit. No source text,
// OCR settings, model settings, or saved conversations are changed.
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { setPriority, constants } from 'node:os';
import { createWorker, PSM } from 'tesseract.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
try { setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
const require = createRequire(import.meta.url);
const db = new DatabaseSync(join(process.env.APPDATA, 'TinyGPT Voice Clone', 'library.sqlite'), { readOnly: true });
const id = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw Error('Provide the source image ID to audit.');
const saved = db.prepare('SELECT s.text,f.original FROM sources s JOIN source_files f ON f.source_id=s.id WHERE s.id=?').get(id);
const bytes = Buffer.from(saved.original);
await writeFile('artifacts/pricing-plan-original.jpeg', bytes);
const image = await loadImage(bytes);
const langPath = join(dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
await readFile(join(langPath, 'eng.traineddata.gz'));
const worker = await createWorker('eng', 1, { langPath, cacheMethod: 'none', gzip: true, logger: () => {} });
const report = { image: { width: image.width, height: image.height, bytes: bytes.length }, engine: 'Tesseract.js 6.0.1 / bundled eng best_int', savedText: saved.text, columns: [] };
try {
  const full = await worker.recognize(bytes, {}, { text: true, blocks: true, tsv: true });
  report.full = { text: full.data.text, confidence: full.data.confidence, matchesSaved: full.data.text.trim() === saved.text.trim() };
  await writeFile('artifacts/pricing-plan-ocr.tsv', full.data.tsv ?? '');
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
  const regions = [['Free', .055, .267], ['Plus', .285, .497], ['Premium', .515, .727], ['Super', .745, .957]];
  for (const [label, left, right] of regions) {
    const region = { x: Math.round(image.width * left), y: Math.round(image.height * .325), width: Math.round(image.width * (right - left)), height: Math.round(image.height * .65) };
    const canvas = createCanvas(region.width * 2, region.height * 2);
    canvas.getContext('2d').drawImage(image, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
    const result = await worker.recognize(canvas.toBuffer('image/png'), {}, { text: true, blocks: true });
    report.columns.push({ label, region, scale: 2, confidence: result.data.confidence, text: result.data.text });
  }
  await writeFile('artifacts/pricing-plan-ocr-audit.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ image: report.image, baselineConfidence: report.full.confidence, matchesSaved: report.full.matchesSaved, columns: report.columns.map(({label,confidence,text})=>({label,confidence,text})) }, null, 2));
} finally { await worker.terminate(); db.close(); }
