import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { extractFile, textExtensions } from './files';
import type { ExtractedDocument } from '../shared/source-files';
import { ocrWords, ocrColumns, regionText, ocrConfidence, numericOCRConflict } from '../core/ocr-layout';

const requireModule = createRequire(typeof __filename === 'string' ? __filename : join(process.cwd(), 'package.json'));
const MAX_TEXT = 500000;
const xmlText = (xml: string) => xml.replace(/<\/(?:w:p|a:p|text:p|row|p)>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
export async function recognizeDocumentImage(bytes: Buffer, signal: AbortSignal): Promise<string> {
  return (await recognizeDocumentOCR(bytes,signal)).text;
}
export async function recognizeDocumentOCR(bytes: Buffer, signal: AbortSignal): Promise<ExtractedDocument> {
  signal.throwIfAborted();
  const { createWorker, PSM } = await import('tesseract.js');
  const { loadImage, createCanvas } = await import('@napi-rs/canvas');
  const image=await loadImage(bytes);
  if(image.width*image.height>32000000)throw Error('OCR image exceeds the pixel limit.');
  const languageRoot = dirname(requireModule.resolve('@tesseract.js-data/eng/package.json'));
  const workerPath = join(dirname(requireModule.resolve('tesseract.js/package.json')), 'src/worker-script/node/index.js').replace('app.asar', 'app.asar.unpacked');
  const langPath = join(languageRoot, '4.0.0_best_int').replace('app.asar', 'app.asar.unpacked');
  await readFile(join(langPath, 'eng.traineddata.gz')); // Missing assets fail locally; no network repair.
  const worker = await createWorker('eng', 1, { workerPath, langPath, cacheMethod: 'none', gzip: true, logger: () => {} });
  const abort = () => { void worker.terminate(); }; signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();const started=Date.now();
    const full=(await worker.recognize(bytes,{}, {text:true,tsv:true})).data;
    const words=ocrWords(full.tsv??''),regions=ocrColumns(words,image.width,image.height);
    if(!regions.length){const notice=full.text.trim()&&full.confidence<75?'OCR text is uncertain. Verify important labels and numbers against the original image.':undefined;return {text:full.text,status:notice?'partial':'ready',...(notice?{notice}:{})};}
    const header=regionText(words.filter(word=>word.y<regions[0].y));
    const sections=[`[OCR-derived text; image ${image.width} × ${image.height}. Regions are geometric reading groups, not verified semantic columns. Verify important values and feature ownership visually.]`,header];
    let pixels=0;
    await worker.setParameters({tessedit_pageseg_mode:PSM.SINGLE_BLOCK});
    for(const [i,region] of regions.entries()){
      signal.throwIfAborted();const original=regionText(region.words),confidence=ocrConfidence(region.words);
      let text=original,alternative='',warning='';
      const typical=region.words.map(w=>w.height).sort((a,b)=>a-b)[Math.floor(region.words.length/2)]??20;
      const scale=Math.min(typical<20?2:1,Math.sqrt(2000000/(region.width*region.height)));
      const width=Math.max(1,Math.round(region.width*scale)),height=Math.max(1,Math.round(region.height*scale));
      if(Date.now()-started<20000&&pixels+width*height<=8000000){
        try {
          const canvas=createCanvas(width,height);canvas.getContext('2d').drawImage(image,region.x,region.y,region.width,region.height,0,0,width,height);pixels+=width*height;
          const retry=(await worker.recognize(canvas.toBuffer('image/png'),{}, {text:true})).data;
          if(retry.text.trim()&&numericOCRConflict(original,retry.text)){warning='Numeric readings disagree; use the original image to verify. Baseline reading retained.';alternative=retry.text.slice(0,2000);}
          else if(retry.text.trim()&&retry.confidence>=confidence-3&&retry.text.length>=original.length*.7)text=retry.text;
        }catch{signal.throwIfAborted();warning='Targeted OCR could not finish; baseline reading retained.';}
      }else warning='Recovery budget reached; baseline reading retained.';
      sections.push(`[Region ${i+1}: x=${region.x}, y=${region.y}, width=${region.width}, height=${region.height}; baseline confidence=${confidence}]\n${warning?'[Verification needed: '+warning+']\n':''}${text}${alternative?'\n[Alternate OCR, unverified]\n'+alternative:''}`);
    }
    return {text:sections.filter(Boolean).join('\n\n'),status:'partial',notice:'Multi-column OCR was grouped by image region with bounded recovery. Verify prices, labels and feature-to-column associations using the original image; OCR confidence is not proof of accuracy.'};
  }
  finally { signal.removeEventListener('abort', abort); await worker.terminate().catch(() => {}); }
}
export async function extractDocument(name: string, bytes: Buffer, signal: AbortSignal): Promise<ExtractedDocument> {
  const extension = name.toLowerCase().split('.').at(-1);
  signal.throwIfAborted(); let text = '', notice: string | undefined;
  if (extension === 'pdf') {
    // Electron utility processes are classified as browsers by PDF.js even
    // though they have no DOM. Supply a local canvas factory explicitly.
    const canvasModule = await import('@napi-rs/canvas');
    for (const key of ['DOMMatrix', 'ImageData', 'Path2D'] as const) (globalThis as any)[key] ??= canvasModule[key];
    class LocalCanvasFactory {
      create(width: number, height: number) { const canvas = canvasModule.createCanvas(width, height); return { canvas, context: canvas.getContext('2d') }; }
      reset(target: any, width: number, height: number) { target.canvas.width = width; target.canvas.height = height; }
      destroy(target: any) { target.canvas.width = 0; target.canvas.height = 0; target.canvas = null; target.context = null; }
    }
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(requireModule.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), CanvasFactory: LocalCanvasFactory as any, isOffscreenCanvasSupported: false, isImageDecoderSupported: false, useWorkerFetch: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
    const abort = () => { void task.destroy(); }; signal.addEventListener('abort', abort, { once: true });
    try {
      const document = await task.promise;
      if (document.numPages > 200) notice = `Only the first 200 of ${document.numPages} pages were processed.`;
      for (let pageNumber = 1; pageNumber <= Math.min(200, document.numPages); pageNumber++) {
        signal.throwIfAborted(); if (text.length >= MAX_TEXT) { notice = 'The extracted text limit was reached; read the original for complete coverage.'; break; }
        const page = await document.getPage(pageNumber), content = await page.getTextContent();
        let passage = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
        if (!passage) {
          try {
          const { createCanvas } = await import('@napi-rs/canvas'); const viewport = page.getViewport({ scale: 1.5 });
          if (viewport.width * viewport.height > 12000000) throw Error('OCR image limit.');
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvas: canvas as any, canvasContext: canvas.getContext('2d') as any, viewport }).promise;
          const recognized = await recognizeDocumentOCR(canvas.toBuffer('image/png'), signal);
          passage = recognized.text.trim() || passage;
          if(recognized.notice)notice='Some scanned pages contain uncertain OCR; inspect the original page for important values and layout.';
          if (!passage) notice = 'Some pages had no readable text; consult the original for complete coverage.';
          } catch { signal.throwIfAborted(); notice = `Some pages, including page ${pageNumber}, could not be OCR-processed. Consult the original for complete coverage.`; }
        }
        text += `\n\nPage ${pageNumber}\n${passage || '[No readable text detected on this page.]'}`;
        page.cleanup();
      }
    } finally { signal.removeEventListener('abort', abort); await task.destroy(); }
  } else if (['png', 'jpg', 'jpeg', 'webp'].includes(extension ?? '')) {
    const recognized=await recognizeDocumentOCR(bytes,signal);text=recognized.text;notice=recognized.notice;
    if (!text.trim()) notice = 'No readable text was detected. The original image remains available for vision.';
  } else if (['docx', 'pptx', 'xlsx', 'odt'].includes(extension ?? '')) {
    const zip = await JSZip.loadAsync(bytes);
    const entries = Object.values(zip.files); if (entries.length > 10000 || entries.reduce((sum, entry) => sum + ((entry as any)._data?.uncompressedSize ?? 0), 0) > 64000000) throw Error('Document expands beyond its processing limit.');
    if (extension === 'xlsx') {
      const { Workbook } = await import('exceljs'); const workbook = new Workbook(); await workbook.xlsx.load(bytes as any);
      let omitted = false;
      workbook.eachSheet(sheet => { text += `\nSheet: ${sheet.name}\n`; sheet.eachRow((row, number) => { signal.throwIfAborted(); if (text.length >= MAX_TEXT) { omitted = true; return; } if (text.length < MAX_TEXT) text += `Row ${number}: ${row.values instanceof Array ? row.values.slice(1).map(value => typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')).join('\t') : ''}\n`; }); });
      if (omitted) notice = 'The extracted text limit was reached; read the original for complete coverage.';
    } else {
      const names = extension === 'docx' ? ['word/document.xml', ...Object.keys(zip.files).filter(path => /^word\/(?:header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(path))] : extension === 'odt' ? ['content.xml'] : Object.keys(zip.files).filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path)).sort((a, b) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]));
      for (const [i, path] of names.entries()) { signal.throwIfAborted(); const entry = zip.file(path); if (entry) text += `\n${extension === 'pptx' ? `Slide ${i + 1}` : 'Document'}\n${xmlText(await entry.async('string'))}`; if (text.length > MAX_TEXT) break; }
    }
    if (Object.keys(zip.files).some(path => /^(?:word|ppt|xl)\/media\//.test(path) || /^Pictures\//.test(path))) notice ??= 'Document text was extracted. Embedded images and diagrams require inspection of the original.';
  } else if (textExtensions.has('.' + extension)) {
    if (bytes.subarray(0, 8192).includes(0)) throw Error('This file is not supported UTF-8 text.');
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } else text = await extractFile(name, bytes, signal);
  if (!text.trim()) notice ??= 'No readable text was detected in this document. The original remains available.';
  if (text.length > MAX_TEXT) notice = 'The extracted text limit was reached; read the original for complete coverage.';
  return { text: text.slice(0, MAX_TEXT), status: notice ? 'partial' : 'ready', ...(notice ? { notice } : {}) };
}
