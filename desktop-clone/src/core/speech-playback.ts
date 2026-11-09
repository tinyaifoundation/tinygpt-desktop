import type { Result } from '../shared/contracts';
import type { SpeechAudio } from '../shared/voice';

/** One phrase ahead: generation overlaps playback without buffering an answer. */
export async function* prefetchedSpeech(request: (chunk: number) => Promise<Result<SpeechAudio>>, alive: () => boolean) {
  const prepare = (chunk: number): Promise<Result<SpeechAudio>> => Promise.resolve().then(() => alive() ? request(chunk) : { ok: false as const, error: 'Read aloud was stopped.' }).catch(error => ({ ok: false as const, error: error instanceof Error ? error.message : 'Read aloud could not finish.' }));
  let pending: Promise<Result<SpeechAudio>> | undefined = prepare(0), chunks = 1;
  for (let chunk = 0; chunk < chunks && alive(); chunk++) {
    const result = await pending!;
    if (!alive()) return;
    if (!result.ok) throw Error(result.error);
    chunks = result.value.chunks;
    pending = chunk + 1 < chunks ? prepare(chunk + 1) : undefined;
    yield result.value;
  }
}
