import { expect, it, vi } from 'vitest';
import { ImageUnderstanding, suggestedRegions, type PreparedPixels } from '../src/main/image-understanding';
import { readingRows, type ImageText } from '../src/main/image-text';
import type { ViewedImage } from '../src/main/image-tools';

const line = (text: string, x = 0, y = 0) => ({ text, box: { x, y, width: 100, height: 30 } });
const text: ImageText = { status: 'ok', engine: 'Local OCR', text: 'Technical Specifications\nInput Voltage AC: 100-240 VAC, 50-60Hz\nOutput Power: 15W Max\nCharging Current: 1A (12V)', lines: Array.from({ length: 10 }, (_, i) => line('row ' + i)), truncated: false };
const viewed: ViewedImage = { metadata: { title: 'Phone screenshot', imageReference: 'tinygpt-image:fixture', width: 706, height: 1536 }, transport: { type: 'tinygpt-image-result', text: '', image: 'preview' }, original: Buffer.from('original pixels') };
function setup(ocr = text) {
  const reader = { extract: vi.fn(async (_png: Buffer, _signal: AbortSignal) => structuredClone(ocr)) }, analyzer = { available: () => true, analyze: vi.fn(async (_image: string, _question: string, _signal: AbortSignal) => ({ observation: '100-240 VAC', incomplete: false })) };
  const crop = vi.fn(region => ({ image: 'full-resolution-crop', region: { ...region, x: region.x + 100, y: region.y + 500 } }));
  const prepare = vi.fn((): PreparedPixels => ({ png: Buffer.from('original-resolution OCR'), width: 1206, height: 2622, region: { x: 100, y: 500, width: 1206, height: 2622 }, image: 'preview', crop }));
  return { reader, analyzer, crop, prepare, service: new ImageUnderstanding(reader, prepare) };
}
it('reconstructs spatial table rows instead of separating all labels from their values', () => {
  const rows = readingRows([line('Output Power:', 20, 100), line('Input Voltage AC:', 20, 50), line('15W Max', 300, 102), line('100-240 VAC', 300, 52)]);
  expect(rows.map(x => x.text)).toEqual(['Input Voltage AC: 100-240 VAC', 'Output Power: 15W Max']);
});
it('returns independent OCR text and one bounded recovery crop when visual generation was truncated', async () => {
  const { reader, analyzer, crop, service } = setup();
  analyzer.analyze.mockResolvedValueOnce({ observation: 'Partial answer', incomplete: true });
  const result = await service.analyze(viewed, 'How many devices? Read "100W" and "USB-C".', analyzer, new AbortController().signal);
  expect(reader.extract.mock.calls[0][0]).toEqual(Buffer.from('original-resolution OCR'));
  expect(result.extractedText).toContain('Output Power: 15W Max'); expect(result.textExtraction.region.y).toBe(500);
  expect(analyzer.analyze).toHaveBeenCalledTimes(2); expect(crop).toHaveBeenCalledOnce();
  expect(analyzer.analyze.mock.calls[1][0]).toBe('full-resolution-crop'); expect(result.inspectedRegions[1].y).toBe(500);
  expect(result.coverage).toBe('partial'); expect(result.generationTruncated).toBe(true);
  for (const call of analyzer.analyze.mock.calls) expect(call[1]).toBe('How many devices? Read "100W" and "USB-C".');
  expect(result.unansweredDetails.join(' ')).toContain('not been independently verified'); expect(result.unansweredDetails.join(' ')).toContain('USB-C');
  expect(result.suggestedCrops[1].y).toBeGreaterThan(500); expect(result.notice).toContain('unknown, not absent');
});
it('preserves distinct checkbox questions on dense screenshots and does not retry a short successful answer', async () => {
  const { service, analyzer, crop } = setup();
  const first = 'Is the Email checkbox selected?', second = 'Is the On GitHub checkbox selected?';
  await service.analyze(viewed, first, analyzer, new AbortController().signal);
  await service.analyze(viewed, second, analyzer, new AbortController().signal);
  expect(analyzer.analyze.mock.calls.map(call => call[1])).toEqual([first, second]);
  expect(crop).not.toHaveBeenCalled();
});
it('returns bounded question-relevant OCR boxes in original-image coordinates', async () => {
  const { service, analyzer, prepare } = setup({ ...text, lines: [line('Other text'), line('Email', 20, 50)] });
  prepare.mockImplementation(() => ({ png: Buffer.from('pixels'), width: 603, height: 1311, region: { x: 100, y: 500, width: 1206, height: 2622 }, image: 'preview', crop: () => ({ image: 'crop', region: { x: 0, y: 0, width: 1, height: 1 } }) }));
  const result = await service.analyze(viewed, 'Is Email checked?', analyzer, new AbortController().signal);
  expect(result.textRegions[0]).toEqual({ text: 'Email', box: { x: 140, y: 600, width: 200, height: 60 } });
  expect(result.notice).toContain('not click targets or checked states');
});
it('does not add automatic crop calls to explicit Pro image analysis', async () => {
  const { service, analyzer } = setup(); await service.analyze(viewed, 'Describe', analyzer, new AbortController().signal, false);
  expect(analyzer.analyze).toHaveBeenCalledOnce();
});
it('reports OCR unavailable explicitly and preserves the original focused question for sparse images', async () => {
  const { service, analyzer } = setup({ ...text, status: 'unavailable', text: '', lines: [] });
  const result = await service.analyze(viewed, 'What color is the circle?', analyzer, new AbortController().signal);
  expect(analyzer.analyze.mock.calls[0][1]).toBe('What color is the circle?'); expect(result.textExtraction.status).toBe('unavailable');
  expect(result.unansweredDetails.join(' ')).toContain('unknown'); expect(result.coverage).toBe('partial');
});
it('keeps useful OCR when visual interpretation fails, and keeps vision when the OCR adapter fails', async () => {
  const a = setup(); a.analyzer.analyze.mockRejectedValue(Error('Model unavailable'));
  const withText = await a.service.analyze(viewed, 'Read labels', a.analyzer, new AbortController().signal);
  expect(withText.visualStatus).toBe('failed'); expect(withText.extractedText).toContain('15W Max'); expect(withText.observation).toBe('');
  const b = setup(); b.reader.extract.mockRejectedValue(Error('OCR unavailable'));
  const withVision = await b.service.analyze(viewed, 'Describe', b.analyzer, new AbortController().signal);
  expect(withVision.textExtraction.status).toBe('failed'); expect(withVision.observation).toContain('100-240 VAC');
});
it('bounds the JSON envelope and reports text/generation clipping', async () => {
  const { service, analyzer } = setup({ ...text, text: '"lots of text"\n'.repeat(3000) });
  analyzer.analyze.mockResolvedValue({ observation: '"very long observation"\n'.repeat(1000), incomplete: true });
  const result = await service.analyze(viewed, 'Describe', analyzer, new AbortController().signal);
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(9300); expect(result.textExtraction.truncated).toBe(true); expect(result.generationTruncated).toBe(true);
});
it('does not start vision after cancellation during OCR', async () => {
  const { service, reader, analyzer } = setup(), abort = new AbortController();
  reader.extract.mockImplementation(async () => { abort.abort(Error('Stop')); return text; });
  await expect(service.analyze(viewed, 'Read', analyzer, abort.signal)).rejects.toThrow('Stop'); expect(analyzer.analyze).not.toHaveBeenCalled();
});
it('offers bounded original-coordinate regions for tall/wide images and none for a small square', () => {
  expect(suggestedRegions(1206, 2622)).toHaveLength(2); expect(suggestedRegions(3000, 1000)).toHaveLength(2); expect(suggestedRegions(512, 512)).toEqual([]);
});
