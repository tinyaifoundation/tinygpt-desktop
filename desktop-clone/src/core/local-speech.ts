/** Small, sentence-aware phrases for a non-autoregressive local speech model.
 * Grow gradually so the next phrase can be prepared while this one plays. */
export function localSpeechChunks(text: string): string[] {
  const chunks: string[] = []; let remaining = text.trim(), limit = 60;
  while (remaining) {
    let end = Math.min(limit, remaining.length);
    if (end < remaining.length) {
      const prefix = remaining.slice(0, end);
      const sentence = [...prefix.matchAll(/[.!?]["')\]]*(?=\s|$)/g)].at(-1);
      const boundary = sentence && sentence.index! + sentence[0].length >= limit * .6 ? sentence.index! + sentence[0].length : prefix.lastIndexOf(' ');
      if (boundary >= limit * .6) end = boundary;
      if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
    }
    const chunk = remaining.slice(0, end).trim(); chunks.push(chunk); remaining = remaining.slice(end).trim();
    limit = Math.min(180, Math.max(60, Math.ceil(chunk.length * 1.15)));
  }
  return chunks;
}

class SpeechTokenLimit extends Error {}
type SpeechEngine = { tokenizer: any; generate: (text: string, options: { voice: string; speed: number }) => Promise<{ audio: Float32Array }> };

/** The pinned library otherwise silently truncates phonemes at 512 tokens. */
export function guardSpeechTokenizer(engine: SpeechEngine): void {
  engine.tokenizer = new Proxy(engine.tokenizer, { apply(target, receiver, [text, options]) {
    const tokens = Reflect.apply(target, receiver, [text, { ...options, truncation: false }]) as { input_ids: { dims: number[] } };
    const length = tokens.input_ids.dims.at(-1);
    if (length === undefined) throw Error('Speech tokenizer did not return valid input.');
    if (length > 512) throw new SpeechTokenLimit();
    return tokens;
  } });
}

export async function generateCompleteSpeech(engine: SpeechEngine, text: string, voice: string): Promise<Float32Array> {
  try { return (await engine.generate(text, { voice, speed: 1 })).audio; }
  catch (error) {
    if (!(error instanceof SpeechTokenLimit)) throw error;
    const points = Array.from(text);
    if (points.length < 2) throw Error('This phrase could not be spoken safely.');
    const middle = points.slice(0, Math.floor(points.length / 2)).join('').length;
    const space = text.lastIndexOf(' ', middle), boundary = space >= middle / 2 ? space : middle;
    const left = await generateCompleteSpeech(engine, text.slice(0, boundary).trim(), voice);
    const right = await generateCompleteSpeech(engine, text.slice(boundary).trim(), voice);
    const audio = new Float32Array(left.length + right.length); audio.set(left); audio.set(right, left.length); return audio;
  }
}
