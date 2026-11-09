import { describe, it, expect } from 'vitest';
import { PocketWaveDecoder, recordingWave, validateVoiceRecording } from '../src/core/pocket-audio';

describe('Pocket TTS audio boundaries', () => {
  it('plays fragmented WAV audio without waiting for the advertised stream length', () => {
    const wave = recordingWave(Float32Array.from([0, .25, -.25, 1, -1]), 24000);
    new DataView(wave.buffer).setUint32(40, 2_000_000_000, true);
    const decoder = new PocketWaveDecoder(), parts: number[] = [];
    for (const byte of wave) parts.push(...decoder.push(Uint8Array.of(byte)));
    decoder.finish(); expect(parts).toEqual([...wave.slice(44)]);
    expect(decoder.sampleRate).toBe(24000);
  });
  it('rejects broken, truncated and incompatible streamed audio', () => {
    const wave = recordingWave(new Float32Array(10), 48000); expect(() => new PocketWaveDecoder().push(wave)).toThrow('unsupported');
    expect(() => new PocketWaveDecoder().finish()).toThrow('incomplete');
    const decoder = new PocketWaveDecoder(); decoder.push(recordingWave(new Float32Array(1), 24000).slice(0, 45)); expect(() => decoder.finish()).toThrow('incomplete');
  });
  it('accepts clear speech-length samples and rejects silent, clipped, short and malformed recordings', () => {
    const samples = Float32Array.from({ length: 24000 * 6 }, (_, i) => Math.sin(i / 15) * .2);
    expect(() => validateVoiceRecording(recordingWave(samples, 24000))).not.toThrow();
    expect(() => validateVoiceRecording(recordingWave(new Float32Array(24000 * 6), 24000))).toThrow('quiet');
    expect(() => validateVoiceRecording(recordingWave(new Float32Array(24000 * 6).fill(1), 24000))).toThrow('distorted');
    expect(() => validateVoiceRecording(recordingWave(samples.slice(0, 24000), 24000))).toThrow('5 and 30');
    const malformed = recordingWave(samples, 24000); new DataView(malformed.buffer).setUint32(40, 0, true); expect(() => validateVoiceRecording(malformed)).toThrow('5 and 30');
  });
});
