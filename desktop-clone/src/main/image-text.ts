import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

export type TextLine = { text: string; box: { x: number; y: number; width: number; height: number } };
export type ImageText = { status: 'ok' | 'unavailable' | 'failed'; engine: string; language?: string; text: string; lines: TextLine[]; truncated: boolean; reason?: string };
export interface ImageTextReader { extract(png: Buffer, signal: AbortSignal): Promise<ImageText>; close?(): void }
const rawSchema = z.object({ status: z.enum(['ok', 'unavailable', 'failed']), engine: z.string().max(80), language: z.string().max(40).optional(), reason: z.string().max(300).optional(), truncated: z.boolean().optional(), lines: z.array(z.object({ text: z.string().max(4000), box: z.object({ x: z.number().finite().min(0), y: z.number().finite().min(0), width: z.number().finite().min(0), height: z.number().finite().min(0) }) })).max(1000).optional() });

/** OCR often returns a table column-by-column. Group geometrically aligned
 * lines before ordering left-to-right; preserve words without correcting values. */
export function readingRows(lines: TextLine[]): TextLine[] {
  const rows: { center: number; height: number; lines: TextLine[] }[] = [];
  for (const line of [...lines].sort((a, b) => a.box.y + a.box.height / 2 - b.box.y - b.box.height / 2)) {
    const center = line.box.y + line.box.height / 2, row = rows.at(-1);
    if (row && Math.abs(row.center - center) <= Math.max(4, Math.min(row.height, line.box.height) * 0.45)) row.lines.push(line);
    else rows.push({ center, height: line.box.height, lines: [line] });
  }
  return rows.map(row => {
    const sorted = row.lines.sort((a, b) => a.box.x - b.box.x), left = Math.min(...sorted.map(x => x.box.x)), top = Math.min(...sorted.map(x => x.box.y));
    return { text: sorted.map(x => x.text).join(' '), box: { x: left, y: top, width: Math.max(...sorted.map(x => x.box.x + x.box.width)) - left, height: Math.max(...sorted.map(x => x.box.y + x.box.height)) - top } };
  });
}
export class WindowsImageText implements ImageTextReader {
  private cache = new Map<string, ImageText>();
  private closing = new AbortController();
  private active = 0;
  constructor(private script: string, private stateRoot: string) {}
  async extract(png: Buffer, signal: AbortSignal): Promise<ImageText> {
    signal.throwIfAborted(); this.closing.signal.throwIfAborted();
    const empty = (status: 'failed' | 'unavailable', reason: string): ImageText => ({ status, engine: 'Windows OCR', text: '', lines: [], truncated: false, reason });
    if (process.platform !== 'win32') return empty('unavailable', 'Local image text extraction is unavailable on this platform.');
    if (png.length > 20 * 1024 * 1024) return empty('failed', 'The image text input exceeds its size limit.');
    const key = createHash('sha256').update(png).digest('hex'), cached = this.cache.get(key);
    if (cached) return structuredClone(cached);
    if (this.active >= 2) return empty('unavailable', 'Local text extraction is busy. Retry a focused crop.');
    this.active++; let folder: string | undefined;
    const ownedSignal = AbortSignal.any([signal, this.closing.signal, AbortSignal.timeout(20000)]);
    try {
      await mkdir(this.stateRoot, { recursive: true }); folder = await mkdtemp(join(this.stateRoot, 'image-'));
      const path = join(folder, 'pixels.png'); await writeFile(path, png, { mode: 0o600 }); ownedSignal.throwIfAborted();
      const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script, '-ImagePath', path], { windowsHide: true, signal: ownedSignal, maxBuffer: 1024 * 1024, encoding: 'utf8' });
      const raw = rawSchema.parse(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()));
      const rows = readingRows(raw.lines ?? []), selected: TextLine[] = []; let size = 0;
      for (const line of rows) { if (size + line.text.length > 18000) break; selected.push(line); size += line.text.length + 1; }
      const result: ImageText = { ...raw, text: selected.map(line => line.text).join('\n'), lines: selected, truncated: !!raw.truncated || selected.length < rows.length };
      if (result.status === 'ok') { this.cache.set(key, structuredClone(result)); while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!); }
      return result;
    } catch {
      signal.throwIfAborted(); this.closing.signal.throwIfAborted();
      return empty('failed', 'Local text extraction failed or timed out. Text may require a closer crop.');
    } finally {
      this.active--;
      if (folder) { await rm(join(folder, 'pixels.png'), { force: true }).catch(() => {}); await rmdir(folder).catch(() => {}); }
    }
  }
  close() { this.closing.abort(Error('Image text extraction stopped.')); this.cache.clear(); }
}
