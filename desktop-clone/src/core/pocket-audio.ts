/** Incremental decoder for the pinned Pocket TTS runtime's mono PCM16 WAV stream.
 * The unseekable WAV advertises a placeholder length; EOF ends the audio. */
export class PocketWaveDecoder {
  private pending = new Uint8Array(0);
  private header = false;
  sampleRate = 24000;
  push(bytes: Uint8Array): Uint8Array {
    const joined = new Uint8Array(this.pending.length + bytes.length);
    joined.set(this.pending); joined.set(bytes, this.pending.length);
    this.pending = joined;
    if (!this.header) {
      if (joined.length < 44) return new Uint8Array();
      const view = new DataView(joined.buffer), tag = (offset: number, count: number) => String.fromCharCode(...joined.slice(offset, offset + count));
      if (tag(0, 4) !== 'RIFF' || tag(8, 8) !== 'WAVEfmt ' || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint16(34, true) !== 16 || tag(36, 4) !== 'data' || view.getUint32(24, true) !== 24000) throw Error('Pocket TTS returned unsupported audio.');
      this.sampleRate = view.getUint32(24, true); this.pending = joined.slice(44); this.header = true;
    }
    const length = this.pending.length - this.pending.length % 2;
    const pcm = this.pending.slice(0, length); this.pending = this.pending.slice(length); return pcm;
  }
  finish() { if (!this.header || this.pending.length) throw Error('Pocket TTS returned incomplete audio.'); }
}

export function recordingWave(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2), view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => [...value].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((value, index) => view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, value)) * 32767), true)); return bytes;
}

export function validateVoiceRecording(bytes: Uint8Array): void {
  if (bytes.length < 44 || bytes.length > 3_000_000 || bytes.length % 2) throw Error('Record between 5 and 30 seconds of clear speech.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), tag = (offset: number, count: number) => String.fromCharCode(...bytes.slice(offset, offset + count));
  const rate = view.getUint32(24, true), duration = (bytes.length - 44) / (rate * 2);
  if (tag(0, 4) !== 'RIFF' || tag(8, 8) !== 'WAVEfmt ' || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint16(34, true) !== 16 || tag(36, 4) !== 'data' || view.getUint32(40, true) !== bytes.length - 44 || ![16000, 22050, 24000, 44100, 48000].includes(rate) || duration < 5 || duration > 30) throw Error('Record between 5 and 30 seconds of clear speech.');
  let energy = 0, clipped = 0;
  for (let offset = 44; offset < bytes.length; offset += 2) { const sample = view.getInt16(offset, true) / 32768; energy += sample * sample; if (Math.abs(sample) > .99) clipped++; }
  const count = (bytes.length - 44) / 2;
  if (Math.sqrt(energy / count) < .008) throw Error('The recording is too quiet. Move closer to your microphone and try again.');
  if (clipped / count > .05) throw Error('The recording is distorted. Move away from your microphone and try again.');
}
