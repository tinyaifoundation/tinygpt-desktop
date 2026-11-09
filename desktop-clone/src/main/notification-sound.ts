import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const limit = 5 * 1024 * 1024;
export function soundMime(bytes: Buffer): 'audio/wav' | 'audio/mpeg' | null {
  if (bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (bytes.length >= 10 && (bytes.toString('ascii', 0, 3) === 'ID3' || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return null;
}
/** A quiet bundled two-note chime; no network or audio-model runtime required. */
export function defaultNotificationSound(): string {
  const rate = 24000, count = Math.round(rate * .55), bytes = Buffer.alloc(44 + count * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) {
    const t = i / rate;
    const note = (offset: number, frequency: number) => { const age = t - offset; return age < 0 ? 0 : Math.min(1, age / .012) * Math.exp(-age * 11) * Math.sin(2 * Math.PI * frequency * age); };
    bytes.writeInt16LE(Math.round((note(0, 660) + note(.11, 880)) * 6500), 44 + i * 2);
  }
  return `data:audio/wav;base64,${bytes.toString('base64')}`;
}
export class NotificationSoundStore {
  private custom: { name: string; url: string } | null = null;
  readonly defaultUrl = defaultNotificationSound();
  constructor(private directory: string) {}
  async load(): Promise<void> {
    try {
      const name = JSON.parse(await readFile(join(this.directory, 'notification-sound.json'), 'utf8')).name;
      const bytes = await readFile(join(this.directory, 'notification-sound.audio'));
      const mime = soundMime(bytes); if (typeof name === 'string' && bytes.length <= limit && mime) this.custom = { name: name.slice(0, 120), url: `data:${mime};base64,${bytes.toString('base64')}` };
    } catch { /* The default chime remains available if a custom file is missing. */ }
  }
  name(): string | null { return this.custom?.name ?? null; }
  url(source: 'default' | 'custom'): string {
    if (source === 'default') return this.defaultUrl;
    if (!this.custom) throw new Error('Choose a custom sound first.'); return this.custom.url;
  }
  async choose(path: string): Promise<void> {
    const { stat } = await import('node:fs/promises');
    const info = await stat(path); if (!info.isFile() || info.size > limit || info.size < 10) throw new Error('Choose a WAV or MP3 notification sound smaller than 5 MB.');
    const bytes = await readFile(path); const mime = soundMime(bytes); if (!mime || bytes.length > limit) throw new Error('This sound could not be read. Choose a WAV or MP3 file.');
    await mkdir(this.directory, { recursive: true }); const temporary = join(this.directory, `notification-sound.${randomUUID()}.tmp`);
    await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary, join(this.directory, 'notification-sound.audio'));
    const name = basename(path).slice(0, 120); const metadata = join(this.directory, `notification-sound.${randomUUID()}.tmp`);
    await writeFile(metadata, JSON.stringify({ name }), { mode: 0o600 }); await rename(metadata, join(this.directory, 'notification-sound.json'));
    this.custom = { name, url: `data:${mime};base64,${bytes.toString('base64')}` };
  }
}
