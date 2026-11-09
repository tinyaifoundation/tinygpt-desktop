import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import type { WebContents } from 'electron';
import { dictationPreferencesSchema } from '../src/shared/voice';
import { DictationService } from '../src/main/dictation-service';

vi.mock('../src/main/dictation-model', () => ({ bundledDictationModel: vi.fn(async () => '/local/model.gguf') }));
let server: WebSocketServer;
let service: DictationService;
let owner: WebContents;
let events: Array<{ phase: string; text?: string; id: string }>;
let received: Buffer[];
let sessionOptions: Record<string, unknown>;
beforeEach(async () => {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  events = []; received = []; sessionOptions = {};
  owner = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: (_channel: string, event: typeof events[number]) => events.push(event) }) as unknown as WebContents;
  service = new DictationService('/unused/runtime');
  vi.spyOn(service as unknown as { ensureServer(signal: AbortSignal): Promise<void> }, 'ensureServer').mockImplementation(async () => {
    Object.assign(service, { server: { port, key: 'test-key' } });
  });
  server.on('connection', (socket, request) => {
    expect(request.headers.authorization).toBe('Bearer test-key');
    expect(request.url).toBe('/v1/audio/transcriptions/realtime');
    socket.send(JSON.stringify({ type: 'session.created' }));
    socket.on('message', (bytes, binary) => {
      if (binary) { received.push(Buffer.from(bytes as Buffer)); socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: 'hello' })); return; }
      const event = JSON.parse(bytes.toString());
      if (event.type === 'session.update') { sessionOptions = event.session; expect(event.session.sample_rate).toBe(16000); socket.send(JSON.stringify({ type: 'session.updated' })); }
      if (event.type === 'input_audio_buffer.commit') {
        socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hello.' }));
        socket.send(JSON.stringify({ type: 'input_audio_buffer.committed' }));
      }
    });
  });
});
afterEach(async () => { service.close(); server.clients.forEach(socket => socket.terminate()); await new Promise<void>(resolve => server.close(() => resolve())); vi.restoreAllMocks(); });
it('streams binary audio locally and delivers the final text before stopping', async () => {
  const id = randomUUID();
  await service.start(id, 16000, owner);
  service.audio(id, owner, new Uint8Array([0, 0, 1, 0]));
  await service.stop(id, owner, false);
  expect(received).toEqual([Buffer.from([0, 0, 1, 0])]);
  expect(events.filter(event => event.text !== undefined).map(event => event.text)).toEqual(['hello', 'Hello.']);
  expect(events.at(-1)?.phase).toBe('stopped');
  expect(() => service.audio(id, owner, new Uint8Array([0, 0]))).toThrow('no longer active');
});
it('rejects overlapping composers and prevents a different window from feeding or stopping the session', async () => {
  const id = randomUUID(); await service.start(id, 16000, owner);
  await expect(service.start(randomUUID(), 16000, owner)).rejects.toThrow('another composer');
  const stranger = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents;
  expect(() => service.audio(id, stranger, new Uint8Array([0, 0]))).toThrow('no longer active');
  await expect(service.stop(id, stranger, true)).rejects.toThrow('no longer active');
  await service.stop(id, owner, true);
  const next = randomUUID(); await service.start(next, 16000, owner); await service.stop(next, owner, true);
});
it('releases the session when its window closes and allows another composer to start', async () => {
  const id = randomUUID(); await service.start(id, 16000, owner);
  (owner as unknown as EventEmitter).emit('destroyed');
  expect(() => service.audio(id, owner, new Uint8Array([0, 0]))).toThrow('no longer active');
  await service.start(randomUUID(), 16000, owner);
});

it('applies selected language, punctuation and pause to the local session', async () => {
  Object.assign(service, { preferences: () => dictationPreferencesSchema.parse({ language: 'de-DE', automaticPunctuation: false, pauseMs: 1200 }) });
  const id = randomUUID(); await service.start(id, 16000, owner); expect(sessionOptions).toEqual({ sample_rate: 16000, language: 'de-DE', automatic_punctuation: false, endpointing_ms: 1200 }); await service.stop(id, owner, true);
});
it('does not start the local engine when transcription is disabled', async () => {
  Object.assign(service, { preferences: () => dictationPreferencesSchema.parse({ enabled: false }) }); await expect(service.start(randomUUID(), 16000, owner)).rejects.toThrow('Enable transcription'); expect(service.isActive()).toBe(false); expect(events).toEqual([]);
});
