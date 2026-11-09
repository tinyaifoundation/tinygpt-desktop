import type { PocketTTS } from './pocket-tts';
import { pocketConnection, pocketVoices } from '../shared/voice';
import { createHash } from 'node:crypto';
import type { HistoryStore } from './history';
import type { SettingsStore } from './store';
import type { SpeechAudio, SpeechCatalog, SpeechRequest } from '../shared/voice';
import { answerMarkdown } from '../core/answer-content';
import { discoverSpeechModels, requestSpeech, speechChunks, speechErrors, speechText } from '../core/speech';

export class SpeechService {
  private catalog?: { key: string; at: number; value: SpeechCatalog };
  private jobs = new Map<string, AbortController>();
  private streams = new Map<string, { iterator: ReturnType<PocketTTS['stream']>; controller: AbortController; sequence: number; busy: boolean; fingerprint: string; original: string; text: () => string; timer?: ReturnType<typeof setTimeout> }>();
  constructor(private history: HistoryStore, private store: SettingsStore, private request: typeof fetch = fetch, private local?: PocketTTS) {}
  async models(refresh = false, warm = false): Promise<SpeechCatalog> {
    const preferences = this.store.getSettings().voice.readAloud;
    if (warm && preferences.enabled && preferences.selection?.connectionId === pocketConnection) void this.local?.warm().catch(() => {});
    const connections = this.store.inferenceConnections().filter(connection => connection.connected);
    const customVoices = await this.local?.listVoices() ?? [];
    const key = JSON.stringify([customVoices, connections.map(connection => [connection.id, connection.config, !!this.store.connectionSecret(connection.id)])]);
    if (!refresh && this.catalog?.key === key && Date.now() - this.catalog.at < 300000) return structuredClone(this.catalog.value);
    const results = await Promise.allSettled(connections.map(connection => discoverSpeechModels(connection, this.store.connectionSecret(connection.id), this.request)));
    const value: SpeechCatalog = { customVoices, models: [...(this.local ? [{ connectionId: pocketConnection, model: 'pocket-tts', name: 'Pocket TTS · streaming', provider: 'On this computer', voices: [...pocketVoices, ...customVoices.map(voice => voice.id)], format: 'pcm' as const }] : []), ...results.flatMap(result => result.status === 'fulfilled' ? result.value : [])], issues: results.flatMap((result, index) => result.status === 'rejected' ? [`${connections[index].name}: speech models could not be loaded.`] : []) };
    this.catalog = { key, at: Date.now(), value }; return structuredClone(value);
  }
  private finalAnswer(conversationId: string, messageId: string): string {
    const conversation = this.history.conversation(conversationId), message = conversation.messages.find(message => message.id === messageId);
    if (!message || message.role !== 'assistant' || message.status !== 'complete' || conversation.mode === 'code' && message.workActivity?.length && !message.workActivity.some(activity => activity.kind === 'prose' && activity.answer)) throw Error(speechErrors[10]);
    const text = speechText(answerMarkdown(message.text, conversation.tools.filter(tool => tool.runId === message.runId)));
    if (!text) throw Error(speechErrors[10]); if (text.length > 200000) throw Error(speechErrors[11]); return text;
  }
  private fingerprint() {
    const preferences = this.store.getSettings().voice.readAloud, selection = preferences.selection;
    if (!selection || !preferences.voice) throw Error(speechErrors[1]);
    if(selection.connectionId===pocketConnection&&this.local)return createHash('sha256').update(JSON.stringify(preferences)).digest('hex');
    const connection = this.store.connection(selection.connectionId), secret = this.store.connectionSecret(selection.connectionId);
    return createHash('sha256').update(JSON.stringify([preferences, connection, secret, this.store.getSettings().openrouter])).digest('hex');
  }
  async read(input: SpeechRequest, owner: number): Promise<SpeechAudio> { return this.generate(input.jobId, owner, input.chunk, () => this.finalAnswer(input.conversationId, input.messageId)); }
  async preview(jobId: string, owner: number): Promise<SpeechAudio> { return this.generate(jobId, owner, 0, () => 'This is TinyGPT’s read aloud voice.', true); }
  private async generate(jobId: string, owner: number, chunk: number, text: () => string, preview = false): Promise<SpeechAudio> {
    if (this.store.getSettings().voice.readAloud.selection?.connectionId === pocketConnection && this.local) return this.beginStream(jobId, owner, chunk, text, preview);
    const controller = new AbortController(), key = `${owner}/${jobId}`;
    this.cancelOwner(owner); if (this.jobs.size >= 8) throw Error(speechErrors[6]); this.jobs.set(key, controller);
    try {
      const preferences = this.store.getSettings().voice.readAloud;
      if (!preview && !preferences.enabled) throw Error(speechErrors[0]);
      const fingerprint = this.fingerprint(), original = text(), chunks = speechChunks(original);
      if (!chunks[chunk]) throw Error(speechErrors[10]);
      const model = (await this.models()).models.find(model => model.connectionId === preferences.selection?.connectionId && model.model === preferences.selection.model);
      controller.signal.throwIfAborted(); if (!model) throw Error(speechErrors[2]); if (this.fingerprint() !== fingerprint || text() !== original) throw Error(speechErrors[10]);
      const connection = this.store.connection(model.connectionId), secret = this.store.connectionSecret(model.connectionId);
      const audio = await requestSpeech(model, connection, secret, chunks[chunk], preferences.voice, this.store.getSettings(), AbortSignal.any([controller.signal, AbortSignal.timeout(150000)]), this.request);
      controller.signal.throwIfAborted(); if (this.fingerprint() !== fingerprint || text() !== original) throw Error(speechErrors[10]);
      return { ...audio, chunks: chunks.length };
    } catch (error) { if (controller.signal.aborted) throw Error(speechErrors[9]); throw error; }
    finally { if (this.jobs.get(key) === controller) this.jobs.delete(key); }
  }
  private async beginStream(jobId: string, owner: number, chunk: number, text: () => string, preview: boolean): Promise<SpeechAudio> {
    this.cancelOwner(owner);
    if (this.jobs.size >= 8) throw Error(speechErrors[6]);
    const key = `${owner}/${jobId}`, controller = new AbortController(); this.jobs.set(key, controller);
    try {
      const preferences = this.store.getSettings().voice.readAloud;
      if (!preview && !preferences.enabled) throw Error(speechErrors[0]);
      if (chunk !== 0 || preferences.selection?.model !== 'pocket-tts') throw Error(speechErrors[2]);
      if (![...pocketVoices, ...(await this.local!.listVoices()).map(voice => voice.id)].includes(preferences.voice)) throw Error(speechErrors[3]);
      controller.signal.throwIfAborted();
      const original = text(), iterator = this.local!.stream(original, preferences.voice, controller.signal);
      this.streams.set(key, { iterator, controller, sequence: 0, busy: false, fingerprint: this.fingerprint(), original, text });
      return await this.nextStream(jobId, owner, 0);
    } catch (error) { const stopped = controller.signal.aborted && error === controller.signal.reason; if (this.jobs.get(key) === controller) this.cancel(jobId, owner); if (stopped) throw Error(speechErrors[9]); throw error; }
  }
  async nextStream(jobId: string, owner: number, sequence: number): Promise<SpeechAudio> {
    const key = `${owner}/${jobId}`, stream = this.streams.get(key);
    if (!stream || stream.busy || stream.sequence !== sequence) throw Error(speechErrors[9]);
    stream.busy = true; clearTimeout(stream.timer); stream.timer = setTimeout(() => this.cancel(jobId, owner), 150000);
    try {
      if (stream.fingerprint !== this.fingerprint() || stream.original !== stream.text()) throw Error(speechErrors[10]);
      const result = await stream.iterator.next(); stream.controller.signal.throwIfAborted();
      if (stream.fingerprint !== this.fingerprint() || stream.original !== stream.text()) throw Error(speechErrors[10]);
      if (result.done) { clearTimeout(stream.timer); this.streams.delete(key); this.jobs.delete(key); return { audio: new Uint8Array(), mime: 'audio/wav', chunks: 1, stream: { sampleRate: 24000, done: true } }; }
      stream.sequence++; clearTimeout(stream.timer); stream.timer = setTimeout(() => this.cancel(jobId, owner), 600000);
      return { audio: result.value.audio, mime: 'audio/wav', chunks: 1, stream: { sampleRate: result.value.sampleRate, done: false } };
    } catch (error) { const stopped = stream.controller.signal.aborted; this.cancel(jobId, owner); if (stopped) throw Error(speechErrors[9]); throw error; }
    finally { stream.busy = false; }
  }
  cancel(jobId: string, owner: number): void {
    const key = `${owner}/${jobId}`; this.jobs.get(key)?.abort(); this.jobs.delete(key);
    const stream = this.streams.get(key); if (stream) { clearTimeout(stream.timer); this.streams.delete(key); void stream.iterator.return(undefined).catch(() => {}); }
  }
  cancelOwner(owner: number): void { for (const key of this.jobs.keys()) if (key.startsWith(`${owner}/`)) this.cancel(key.slice(key.indexOf('/') + 1), owner); }
  close(): void { for (const key of [...this.jobs.keys()]) { const [owner, id] = key.split('/'); this.cancel(id, Number(owner)); } this.local?.close(); }
}
