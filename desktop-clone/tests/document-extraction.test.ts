import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { Workbook } from 'exceljs';
import { invoiceImage, scannedPdf } from './fixtures/document-fixtures';
import { extractDocument } from '../src/main/document-extraction';
const signal = () => AbortSignal.timeout(60000);
it('extracts real images and scanned PDF pages with local English OCR', async () => {
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => { throw Error('Network disabled in document extraction test'); };
  try {
    const image = await extractDocument('invoice.png', invoiceImage().toBuffer('image/png'), signal());
    expect(image.text).toContain('4287'); expect(image.status).toBe('ready');
    const pdf = await extractDocument('scan.pdf', scannedPdf(), signal()); expect(pdf.text).toContain('Page 1'); expect(pdf.text).toContain('4287'); expect(pdf.status).toBe('ready');
  } finally { globalThis.fetch = originalFetch; }
}, 90000);
it('retains paragraph, slide and spreadsheet row provenance for common Office uploads', async () => {
  const docx = new JSZip(); docx.file('word/document.xml','<w:document><w:p><w:r><w:t>Alpha &amp; Beta</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:document>');
  expect((await extractDocument('report.docx',await docx.generateAsync({type:'nodebuffer'}),signal())).text).toContain('Alpha & Beta\nSecond paragraph');
  const pptx = new JSZip(); pptx.file('ppt/slides/slide2.xml','<a:p><a:t>Later</a:t></a:p>'); pptx.file('ppt/slides/slide1.xml','<a:p><a:t>First</a:t></a:p>');
  expect((await extractDocument('deck.pptx',await pptx.generateAsync({type:'nodebuffer'}),signal())).text).toMatch(/Slide 1\nFirst[\s\S]*Slide 2\nLater/);
  const book = new Workbook(); book.addWorksheet('Budget').addRow(['Travel',4287]);
  expect((await extractDocument('budget.xlsx',Buffer.from(await book.xlsx.writeBuffer()),signal())).text).toContain('Sheet: Budget\nRow 1: Travel\t4287');
});
it('reports bounded partial extraction and rejects unsupported/cancelled documents', async () => {
  const result = await extractDocument('large.txt',Buffer.from('x'.repeat(510000)),signal()); expect(result.text).toHaveLength(500000); expect(result.status).toBe('partial');
  await expect(extractDocument('program.exe',Buffer.from('invalid'),signal())).rejects.toThrow();
  await expect(extractDocument('file.txt',Buffer.from('text'),AbortSignal.abort())).rejects.toThrow();
});
