import { expect, it, vi } from 'vitest';
import { localSpeechChunks, guardSpeechTokenizer, generateCompleteSpeech } from '../src/core/local-speech';
import { prefetchedSpeech } from '../src/core/speech-playback';
import { speechVoiceDisplay, type SpeechAudio } from '../src/shared/voice';
import type { Result } from '../src/shared/contracts';

it('keeps all text, starts with a small phrase and stays bounded even on long Unicode words', () => {
  const text = 'Read aloud should start speaking quickly. You can keep working while the next sentence is prepared. '.repeat(30) + '🙂'.repeat(500);
  const chunks = localSpeechChunks(text);
  expect(chunks[0].length).toBeLessThanOrEqual(60); expect(chunks.every(chunk => chunk.length <= 180)).toBe(true);
  expect(chunks.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  expect(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
  expect(localSpeechChunks('   ')).toEqual([]);
});

it('prevents silent model truncation and recursively speaks all over-budget text in order', async () => {
  const spoken: string[] = [];
  const engine = { tokenizer: (text: string, options: { truncation: boolean }) => ({ input_ids: { dims: [1, options.truncation ? Math.min(text.length, 512) : text.length] } }), async generate(text: string) { engine.tokenizer(text, { truncation: true }); spoken.push(text); return { audio: Float32Array.of(text.length) }; } };
  guardSpeechTokenizer(engine);
  const text = 'word '.repeat(300).trim(), audio = await generateCompleteSpeech(engine, text, 'af_heart');
  expect(spoken.join(' ')).toBe(text); expect(spoken.every(text => text.length <= 512)).toBe(true);
  expect(audio.length).toBe(spoken.length);
});

it('prepares exactly one next phrase during playback and surfaces its error only when needed', async () => {
  let finish!: (value: Result<SpeechAudio>) => void, alive = true;
  const value: SpeechAudio = { audio: new Uint8Array(48), mime: 'audio/wav', chunks: 3 };
  const request = vi.fn((chunk: number): Promise<Result<SpeechAudio>> => chunk ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, value }));
  const stream = prefetchedSpeech(request, () => alive);
  expect((await stream.next()).value).toBe(value);
  expect(request.mock.calls.map(([chunk]) => chunk)).toEqual([0, 1]);
  await Promise.resolve(); expect(request).toHaveBeenCalledTimes(2);
  alive = false; finish({ ok: false, error: 'Cancelled' }); expect((await stream.next()).done).toBe(true);
  const failed = prefetchedSpeech(async chunk => chunk ? { ok: false, error: 'Next phrase failed' } : { ok: true, value }, () => true);
  await failed.next(); await expect(failed.next()).rejects.toThrow('Next phrase failed');
});

it('displays names and countries while retaining original voice identifiers for synthesis', () => {
  expect(speechVoiceDisplay('bm_george')).toEqual({ name: 'George', country: 'GB' });
  expect(speechVoiceDisplay('af_heart')).toEqual({ name: 'Heart', country: 'US' });
  expect(speechVoiceDisplay('am_michael')).toEqual({ name: 'Michael', country: 'US' });
  expect(speechVoiceDisplay('cedar')).toEqual({ name: 'Cedar' });
});
