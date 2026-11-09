import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { InferenceConnection } from '../shared/inference-connections';
import type { SpeechModel } from '../shared/voice';
import type { Settings } from '../shared/config';
import { openRouterAttributionFetch } from './openrouter-attribution';

export const speechErrors = ['Enable read aloud in Voice settings first.', 'Choose a speech model and voice in Voice settings.', 'Your speech model is unavailable. Refresh Voice settings and choose another model.', 'This voice is unavailable for the selected speech model.', 'The speech provider did not accept your credentials.', 'The speech provider is rate limited. Try again later.', 'The speech provider could not generate audio. Check the model and voice.', 'The provider returned unsupported audio.', 'The spoken audio is too large.', 'Read aloud was stopped.', 'This final answer is no longer available.', 'This answer is too long to read aloud.'];
const voices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
export function speechText(markdown: string): string {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const render = (node: any): string => {
    if (['code', 'html', 'definition', 'footnoteDefinition', 'footnoteReference'].includes(node.type)) return '';
    if (node.type === 'text' || node.type === 'inlineCode') return node.value;
    if (node.type === 'image') return node.alt ?? '';
    if (node.type === 'break') return '\n';
    const separator = ['root', 'list', 'table', 'tableRow'].includes(node.type) ? '\n' : '';
    return (node.children ?? []).map(render).join(separator) + (['paragraph', 'heading', 'listItem', 'blockquote'].includes(node.type) ? '\n' : '');
  };
  return render(tree).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
export function speechChunks(text: string, limit = 1600): string[] {
  const chunks: string[] = []; let remaining = text.trim();
  while (remaining) { let end = Math.min(limit, remaining.length); if (end < remaining.length) { const boundary = Math.max(remaining.lastIndexOf('\n', end), remaining.lastIndexOf('. ', end), remaining.lastIndexOf(' ', end)); if (boundary > limit / 2) end = boundary + 1; if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--; } chunks.push(remaining.slice(0, end).trim()); remaining = remaining.slice(end).trim(); }
  return chunks;
}
async function boundedBytes(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  if (!response.ok) throw Error(response.status === 401 || response.status === 403 ? speechErrors[4] : response.status === 429 ? speechErrors[5] : speechErrors[6]);
  if (!response.body) throw Error(speechErrors[7]); const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { signal.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > limit) throw Error(speechErrors[8]); chunks.push(chunk.value); } } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
export async function discoverSpeechModels(connection: InferenceConnection, secret?: string, request: typeof fetch = fetch): Promise<SpeechModel[]> {
  const provider = connection.route === 'byok' ? connection.config.provider : 'local'; if (provider === 'anthropic' || provider === 'xai') return [];
  const signal = AbortSignal.timeout(12000), headers: Record<string, string> = { Accept: 'application/json' }; if (secret) headers.Authorization = `Bearer ${secret}`;
  const path = provider === 'openrouter' ? '/models?output_modalities=speech' : '/models';
  const bytes = await boundedBytes(await openRouterAttributionFetch(request)(connection.config.endpoint.replace(/\/+$/, '') + path, { headers, signal, redirect: 'error' }), 4_000_000, signal);
  let data: any; try { data = JSON.parse(bytes.toString()).data; } catch { throw Error(speechErrors[7]); } if (!Array.isArray(data)) throw Error(speechErrors[7]);
  return data.slice(0, 10000).flatMap((item: any): SpeechModel[] => {
    if (typeof item.id !== 'string' || item.id.length > 200) return [];
    const known = /^(?:openai\/)?(?:tts-1(?:-hd)?(?:-\d{4})?|gpt-4o-mini-tts(?:-\d{4}-\d{2}-\d{2})?)$/.test(item.id);
    const outputs = item.architecture?.output_modalities ?? item.output_modalities ?? [];
    if (!known && !outputs.includes('speech')) return [];
    const available = Array.isArray(item.supported_voices) ? item.supported_voices.filter((voice: unknown): voice is string => typeof voice === 'string' && voice.length > 0 && voice.length <= 200).slice(0, 500) : known ? voices.filter(voice => !/tts-1/.test(item.id) || !['ballad', 'verse', 'marin', 'cedar'].includes(voice)) : [];
    if (!available.length) return []; // No guessed voices for arbitrary models.
    return [{ connectionId: connection.id, model: item.id, name: typeof item.name === 'string' ? item.name.slice(0, 200) : item.id, provider: connection.name, voices: [...new Set<string>(available)], format: provider === 'openrouter' && /^(?:google|canopylabs|sesame|hexgrad)\//.test(item.id) ? 'pcm' : 'mp3' }];
  });
}
export function pcmWave(bytes: Buffer): Buffer {
  if (!bytes.length || bytes.length % 2) throw Error(speechErrors[7]); const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(bytes.length + 36, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(bytes.length, 40); return Buffer.concat([header, bytes]);
}
export async function requestSpeech(model: SpeechModel, connection: InferenceConnection, secret: string | undefined, input: string, voice: string, settings: Settings, signal: AbortSignal, request: typeof fetch = fetch): Promise<{ audio: Uint8Array; mime: 'audio/mpeg' | 'audio/wav' }> {
  if (!model.voices.includes(voice)) throw Error(speechErrors[3]); if (!input || input.length > 1800) throw Error(speechErrors[11]);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }; if (secret) headers.Authorization = `Bearer ${secret}`;
  const payload: Record<string, unknown> = { model: model.model, input, voice, response_format: model.format };
  if (connection.route === 'byok' && connection.config.provider === 'openrouter') payload.provider = { zdr: settings.openrouter.zeroDataRetention, data_collection: settings.openrouter.allowDataCollection ? 'allow' : 'deny' };
  const response = await openRouterAttributionFetch(request)(connection.config.endpoint.replace(/\/+$/, '') + '/audio/speech', { method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error', signal });
  const bytes = await boundedBytes(response, 20_000_000, signal), type = response.headers.get('content-type')?.split(';')[0];
  if (!bytes.length || type && !type.startsWith('audio/') && type !== 'application/octet-stream') throw Error(speechErrors[7]);
  if (bytes.length >= 44 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE') return { audio: Uint8Array.from(bytes), mime: 'audio/wav' };
  if (bytes.subarray(0, 3).toString() === 'ID3' || bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0) return { audio: Uint8Array.from(bytes), mime: 'audio/mpeg' };
  if (model.format === 'pcm' && (!type || ['audio/pcm', 'audio/l16', 'audio/L16', 'application/octet-stream'].includes(type))) return { audio: Uint8Array.from(pcmWave(bytes)), mime: 'audio/wav' };
  throw Error(speechErrors[7]);
}
