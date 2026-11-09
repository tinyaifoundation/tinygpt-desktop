import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { defaultSettings, settingsSchema } from '../src/shared/config';
import { discoverSpeechModels, pcmWave, requestSpeech, speechChunks, speechText } from '../src/core/speech';
import { SpeechService } from '../src/main/speech-service';
import type { InferenceConnection } from '../src/shared/inference-connections';
import type { HistoryStore } from '../src/main/history';
import type { SettingsStore } from '../src/main/store';
import type { SpeechModel } from '../src/shared/voice';
import type { PocketTTS } from '../src/main/pocket-tts';
import { pocketConnection } from '../src/shared/voice';

function fixture() {
  const connection: InferenceConnection = { id: randomUUID(), name: 'Speech provider', route: 'byok', config: { ...defaultSettings.byok, provider: 'openrouter', endpoint: 'https://openrouter.ai/api/v1' } };
  const model: SpeechModel = { connectionId: connection.id, model: 'google/tts-fixture', name: 'Speech', provider: connection.name, voices: ['Kore', 'Puck'], format: 'pcm' };
  const settings = structuredClone(defaultSettings); settings.voice.readAloud = { enabled: true, selection: { connectionId: model.connectionId, model: model.model }, voice: 'Kore', speed: 1 };
  const message = { id: randomUUID(), role: 'assistant', text: '**Only this final answer.**', status: 'complete', runId: 'run', reasoning: 'PRIVATE REASONING' };
  const conversation = { id: randomUUID(), mode: 'chat', messages: [message], tools: [{ name: 'read_project_file', runId: 'run', status: 'success', result: 'PRIVATE TOOL CONTENT' }] };
  const request = vi.fn(async (url: string | URL | Request, options?: RequestInit) => String(url).includes('/models') ? Response.json({ data: [{ id: model.model, name: 'Speech', architecture: { input_modalities: ['text'], output_modalities: ['speech'] }, supported_voices: model.voices }] }) : new Response(new Uint8Array(480), { headers: { 'Content-Type': 'audio/pcm' } }));
  const store = { getSettings: () => settings, inferenceConnections: () => [{ ...connection, connected: true }], connection: () => connection, connectionSecret: () => 'fixture-secret' } as unknown as SettingsStore;
  const history = { conversation: () => conversation } as unknown as HistoryStore;
  return { connection, model, settings, message, conversation, request, service: new SpeechService(history, store, request as typeof fetch) };
}
describe('speech model discovery and requests', () => {
  it('migrates existing preferences with local transcription on and read aloud off', () => {
    const { voice, ...old } = defaultSettings; expect(settingsSchema.parse(old).voice).toEqual(voice);
    expect(settingsSchema.safeParse({ ...old, voice: { dictation: { language: 'made-up' } } }).success).toBe(false);
  });
  it('discovers speech models and actual voices, excluding chat/audio-transcription-only models', async () => {
    const f = fixture(); const models = await discoverSpeechModels(f.connection, 'fixture-key', f.request as typeof fetch); expect(models).toEqual([f.model]); expect(String(f.request.mock.calls[0][0])).toContain('/models?output_modalities=speech');
    f.request.mockImplementation(async () => Response.json({ data: [{ id: 'chat', architecture: { output_modalities: ['text', 'audio'] } }, { id: 'unknown-speech', output_modalities: ['speech'] }, { id: 'gpt-4o-mini-tts' }, { id: 'tts-1-hd' }] }));
    const discovered = await discoverSpeechModels({ ...f.connection, config: { ...f.connection.config, provider: 'openai' } }, 'key', f.request as typeof fetch); expect(discovered.map(model => model.model)).toEqual(['gpt-4o-mini-tts', 'tts-1-hd']); expect(discovered[0].voices).toContain('cedar'); expect(discovered[1].voices).not.toContain('cedar');
  });
  it('uses the selected credentials, voice and speech API, honoring routing privacy without speed fields', async () => {
    const f = fixture(); f.settings.openrouter.zeroDataRetention = true;
    const result = await requestSpeech(f.model, f.connection, 'fixture-secret', 'Final answer.', 'Puck', f.settings, new AbortController().signal, f.request as typeof fetch);
    expect(result.mime).toBe('audio/wav'); expect(Buffer.from(result.audio).subarray(0, 4).toString()).toBe('RIFF'); const [url, options] = f.request.mock.calls[0]; expect(String(url)).toBe('https://openrouter.ai/api/v1/audio/speech'); expect(options?.redirect).toBe('error'); expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer fixture-secret');
    expect(JSON.parse(String(options?.body))).toEqual({ model: f.model.model, input: 'Final answer.', voice: 'Puck', response_format: 'pcm', provider: { zdr: true, data_collection: 'deny' } });
    await expect(requestSpeech(f.model, f.connection, 'key', 'Answer', 'guessed-voice', f.settings, new AbortController().signal, f.request as typeof fetch)).rejects.toThrow('voice');
  });
  it('rejects provider errors and unsupported response bodies without exposing provider text or credentials', async () => {
    const f = fixture(); f.request.mockImplementation(async () => new Response('SECRET RAW ERROR', { status: 401 })); await expect(requestSpeech(f.model, f.connection, 'SECRET', 'Answer', 'Kore', f.settings, new AbortController().signal, f.request as typeof fetch)).rejects.toThrow('credentials');
    f.request.mockImplementation(async () => Response.json({ secret: 'RAW BODY' })); await expect(requestSpeech(f.model, f.connection, 'key', 'Answer', 'Kore', f.settings, new AbortController().signal, f.request as typeof fetch)).rejects.toThrow('unsupported audio'); expect(() => pcmWave(Buffer.from([0]))).toThrow();
  });
  it('reads markdown as prose and splits long final answers without losing text or breaking surrogate pairs', () => {
    expect(speechText('# Heading\n\n**Hello** [reader](https://secret.example)!\n\n```js\nsecretCode();\n```\n\n![A diagram](private.png)')).toBe('Heading\n\nHello reader!\n\nA diagram');
    const text = Array(80).fill('A complete sentence with punctuation.').join(' '), chunks = speechChunks(text); expect(chunks.length).toBeGreaterThan(1); expect(chunks.every(chunk => chunk.length <= 1600)).toBe(true); expect(chunks.join(' ')).toBe(text);
    expect(speechChunks('🙂'.repeat(2000)).every(chunk => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
  });
});
describe('final-answer read aloud', () => {
  it('streams local audio before the answer finishes without contacting configured speech catalogs', async () => {
    const f = fixture();
    f.settings.voice.readAloud.selection = { connectionId: pocketConnection, model: 'pocket-tts' }; f.settings.voice.readAloud.voice = 'alba';
    f.message.text = 'Read this answer from start to finish. '.repeat(100);
    const stream = vi.fn(async function* (_text: string, _voice: string, _signal: AbortSignal) { yield { audio: new Uint8Array(480), sampleRate: 24000 }; yield { audio: new Uint8Array(240), sampleRate: 24000 }; });
    const local = { stream, listVoices: async () => [] } as unknown as PocketTTS;
    const store = { getSettings: () => f.settings } as unknown as SettingsStore;
    const service = new SpeechService({ conversation: () => f.conversation } as unknown as HistoryStore, store, f.request as typeof fetch, local);
    const input = { conversationId: f.conversation.id, messageId: f.message.id, jobId: randomUUID(), chunk: 0 };
    const first = await service.read(input, 1);
    expect(first.stream).toEqual({ sampleRate: 24000, done: false }); expect(stream.mock.calls[0][0]).toBe(speechText(f.message.text));
    await expect(service.nextStream(input.jobId, 2, 1)).rejects.toThrow('stopped');
    await expect(service.nextStream(input.jobId, 1, 2)).rejects.toThrow('stopped');
    expect((await service.nextStream(input.jobId, 1, 1)).audio.length).toBe(240);
    expect((await service.nextStream(input.jobId, 1, 2)).stream?.done).toBe(true);
    await expect(service.nextStream(input.jobId, 1, 3)).rejects.toThrow('stopped');
    expect(f.request).not.toHaveBeenCalled();
  });
  it('aborts local streaming on Stop, a changed answer, or changed voice preferences', async () => {
    const f = fixture(); f.settings.voice.readAloud.selection = { connectionId: pocketConnection, model: 'pocket-tts' }; f.settings.voice.readAloud.voice = 'alba';
    let signal: AbortSignal | undefined, closed = 0;
    const local = { listVoices: async () => [], stream: async function* (_text: string, _voice: string, current: AbortSignal) { signal = current; try { while (true) yield { audio: new Uint8Array(48), sampleRate: 24000 }; } finally { closed++; } } } as unknown as PocketTTS;
    const service = new SpeechService({ conversation: () => f.conversation } as unknown as HistoryStore, { getSettings: () => f.settings } as unknown as SettingsStore, f.request as typeof fetch, local);
    let job = randomUUID(); await service.preview(job, 1); service.cancel(job, 2); expect(signal?.aborted).toBe(false); service.cancel(job, 1); expect(signal?.aborted).toBe(true);
    job = randomUUID(); await service.preview(job, 1); f.settings.voice.readAloud.voice = 'jean'; await expect(service.nextStream(job, 1, 1)).rejects.toThrow('final answer'); expect(signal?.aborted).toBe(true);
    job = randomUUID(); await service.read({ conversationId: f.conversation.id, messageId: f.message.id, jobId: job, chunk: 0 }, 1); f.message.text = 'Changed'; await expect(service.nextStream(job, 1, 1)).rejects.toThrow('final answer');
    await vi.waitFor(() => expect(closed).toBe(3));
  });
  it('honors Stop while the local voice catalog is still loading', async () => {
    const f = fixture(); f.settings.voice.readAloud.selection = { connectionId: pocketConnection, model: 'pocket-tts' }; f.settings.voice.readAloud.voice = 'alba';
    let finish: (() => void) | undefined;
    const stream = vi.fn();
    const local = { stream, listVoices: () => new Promise(resolve => { finish = () => resolve([]); }) } as unknown as PocketTTS;
    const service = new SpeechService({ conversation: () => f.conversation } as unknown as HistoryStore, { getSettings: () => f.settings } as unknown as SettingsStore, f.request as typeof fetch, local);
    const job = randomUUID(), pending = service.preview(job, 1); service.cancel(job, 1); finish!(); await expect(pending).rejects.toThrow('stopped'); expect(stream).not.toHaveBeenCalled();
  });
  it('sends final answer text only and never reasoning, tool results, or Work commentary', async () => {
    const f = fixture(), input = { conversationId: f.conversation.id, messageId: f.message.id, jobId: randomUUID(), chunk: 0 };
    const audio = await f.service.read(input, 1); expect(audio.chunks).toBe(1); const request = f.request.mock.calls.find(call => String(call[0]).endsWith('/audio/speech'))!; expect(JSON.parse(String(request[1]?.body)).input).toBe('Only this final answer.');
    Object.assign(f.conversation, { mode: 'code' }); Object.assign(f.message, { workActivity: [{ kind: 'prose', text: 'PRIVATE COMMENTARY' }, { kind: 'tool', text: 'PRIVATE TOOL' }, { kind: 'prose', answer: true, text: f.message.text }] }); await f.service.read({ ...input, jobId: randomUUID() }, 1); expect(JSON.stringify(f.request.mock.calls)).not.toContain('PRIVATE');
  });
  it('blocks disabled, incomplete and off-branch messages before any generation request', async () => {
    const f = fixture(), input = { conversationId: f.conversation.id, messageId: f.message.id, jobId: randomUUID(), chunk: 0 }; f.settings.voice.readAloud.enabled = false; await expect(f.service.read(input, 1)).rejects.toThrow('Enable'); f.settings.voice.readAloud.enabled = true; f.message.status = 'streaming'; await expect(f.service.read(input, 1)).rejects.toThrow('final answer'); f.message.status = 'complete'; await expect(f.service.read({ ...input, messageId: randomUUID() }, 1)).rejects.toThrow('final answer'); expect(f.request).not.toHaveBeenCalled();
  });
  it('cancels only the requesting window’s job and refuses settings changed during generation', async () => {
    const f = fixture(); await f.service.models(); let signal: AbortSignal | undefined, complete: (() => void) | undefined;
    f.request.mockImplementation(async (_url, options) => new Promise(resolve => { signal = options?.signal as AbortSignal; complete = () => resolve(new Response(new Uint8Array(48), { headers: { 'Content-Type': 'audio/pcm' } })); }));
    const jobId = randomUUID(), pending = f.service.read({ conversationId: f.conversation.id, messageId: f.message.id, jobId, chunk: 0 }, 1); await vi.waitFor(() => expect(signal).toBeDefined()); f.service.cancel(jobId, 2); expect(signal!.aborted).toBe(false); f.service.cancel(jobId, 1); expect(signal!.aborted).toBe(true); complete!(); await expect(pending).rejects.toThrow('stopped');
    signal = undefined; const next = f.service.preview(randomUUID(), 1); await vi.waitFor(() => expect(signal).toBeDefined()); f.settings.voice.readAloud.voice = 'Puck'; complete!(); await expect(next).rejects.toThrow('final answer');
  });
});
