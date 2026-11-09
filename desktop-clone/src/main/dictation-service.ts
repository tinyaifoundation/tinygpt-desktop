import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { constants, setPriority } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import type { WebContents } from 'electron';
import type { DictationEvent } from '../shared/dictation';
import { DictationTranscript } from '../core/dictation';
import { bundledDictationModel } from './dictation-model';
import { dictationPreferencesSchema, type DictationPreferences } from '../shared/voice';

type Session = {
  id: string; owner: WebContents; abort: AbortController; socket?: WebSocket;
  transcript: DictationTranscript; text?: string; finish?: () => void; finishing?: Promise<void>;
};
export class DictationService {
  private session?: Session;
  private process?: ChildProcess;
  private server?: { port: number; key: string };
  private modelPath?: string;
  private idle?: ReturnType<typeof setTimeout>;
  constructor(private runtimeRoot: string, private preferences: () => DictationPreferences = () => dictationPreferencesSchema.parse({})) {}
  isActive(): boolean { return !!this.session; }
  private emit(session: Session, event: Omit<DictationEvent, 'id'>) {
    if (!session.owner.isDestroyed()) session.owner.send('tinygpt:dictation-event', { id: session.id, ...event });
  }
  private owned(id: string, owner: WebContents) {
    if (!this.session || this.session.id !== id || this.session.owner !== owner) throw new Error('Dictation session is no longer active.');
    return this.session;
  }
  async start(id: string, sampleRate: number, owner: WebContents): Promise<void> {
    const preferences = this.preferences();
    if (!preferences.enabled) throw new Error('Enable transcription in Voice settings first.');
    if (this.session) throw new Error('Dictation is already active in another composer.');
    clearTimeout(this.idle);
    const session: Session = { id, owner, abort: new AbortController(), transcript: new DictationTranscript() };
    this.session = session;
    const destroyed = () => this.cancelSession(session);
    owner.once('destroyed', destroyed);
    session.abort.signal.addEventListener('abort', () => owner.removeListener('destroyed', destroyed), { once: true });
    try {
      if (!this.modelPath) {
        this.emit(session, { phase: 'loading' });
        this.modelPath = await bundledDictationModel(this.runtimeRoot);
      }
      session.abort.signal.throwIfAborted();
      this.emit(session, { phase: 'loading' });
      await this.ensureServer(session.abort.signal);
      session.abort.signal.throwIfAborted();
      const { port, key } = this.server!;
      const socket = session.socket = new WebSocket(`ws://127.0.0.1:${port}/v1/audio/transcriptions/realtime`, {
        headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 15000, maxPayload: 1024 * 1024,
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Dictation could not start. Try again.')), 15000);
        const settle = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
        session.abort.signal.addEventListener('abort', () => settle(new Error('Dictation canceled.')), { once: true });
        socket.on('open', () => socket.send(JSON.stringify({ type: 'session.update', session: { sample_rate: sampleRate, language: preferences.language, automatic_punctuation: preferences.automaticPunctuation, endpointing_ms: preferences.pauseMs } })));
        socket.on('message', bytes => {
          if (session.abort.signal.aborted) return;
          try {
            const event = JSON.parse(bytes.toString());
            if (event.type === 'session.updated') { this.emit(session, { phase: 'listening' }); settle(); }
            else if (event.type === 'error') { const error = new Error('The local dictation engine encountered an error. Try again.'); settle(error); this.fail(session, error.message); }
            else if (event.type === 'input_audio_buffer.committed') session.finish?.();
            else {
              const text = session.transcript.accept(event);
              if (text !== undefined && text !== session.text) {
                session.text = text;
                this.emit(session, { phase: session.finishing ? 'finishing' : 'listening', text });
              }
            }
          } catch { settle(new Error('Dictation returned an invalid response.')); this.fail(session, 'Dictation returned an invalid response.'); }
        });
        socket.on('error', () => { settle(new Error('Could not connect to local dictation.')); this.fail(session, 'Could not connect to local dictation.'); });
        socket.on('close', () => { settle(new Error('Local dictation disconnected.')); if (!session.abort.signal.aborted) this.fail(session, 'Local dictation disconnected. Try again.'); });
      });
    } catch (error) {
      if (!session.abort.signal.aborted) this.fail(session, error instanceof Error ? error.message : 'Dictation could not start.');
      throw error;
    }
  }
  audio(id: string, owner: WebContents, bytes: Uint8Array) {
    const session = this.owned(id, owner);
    if (session.finishing || session.socket?.readyState !== WebSocket.OPEN) throw new Error('Dictation session is no longer active.');
    if (session.socket.bufferedAmount > 2 * 1024 * 1024) { this.fail(session, 'Dictation could not keep up. Please try again.'); throw new Error('Dictation could not keep up.'); }
    session.socket.send(Buffer.from(bytes));
  }
  async stop(id: string, owner: WebContents, cancel: boolean) {
    const session = this.owned(id, owner);
    if (cancel || !session.socket || session.socket.readyState !== WebSocket.OPEN) { this.cancelSession(session); return; }
    if (session.finishing) return session.finishing;
    this.emit(session, { phase: 'finishing' });
    session.finishing = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(session, 'Dictation took too long to finish. Your current text is kept.'); reject(new Error('Dictation timed out.')); }, 15000);
      session.finish = () => { clearTimeout(timer); this.emit(session, { phase: 'stopped' }); this.cancelSession(session); resolve(); };
      session.abort.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      session.socket!.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    });
    return session.finishing;
  }
  private fail(session: Session, error: string) { if (session.abort.signal.aborted) return; this.emit(session, { phase: 'error', error }); this.cancelSession(session); }
  private cancelSession(session: Session) {
    session.abort.abort(); session.socket?.terminate();
    if (this.session === session) {
      this.session = undefined;
      // Release model memory after a quiet period; keep repeated dictation fast.
      this.idle = setTimeout(() => this.close(), 5 * 60_000);
    }
  }
  private async ensureServer(signal: AbortSignal) {
    if (this.server && this.process && this.process.exitCode === null) return;
    const prepared = JSON.parse(await readFile(join(this.runtimeRoot, 'prepared.json'), 'utf8').catch(() => { throw new Error('The dictation runtime is missing. Prepare it with npm run runtime:dictation.'); }));
    if (prepared.target !== `${process.platform}-${process.arch}` || prepared.version !== '0.2.0') throw new Error('The dictation runtime does not match this computer.');
    const executable = join(this.runtimeRoot, prepared.executable); await access(executable);
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const address = probe.address(); const port = typeof address === 'object' && address ? address.port : 0; probe.close(error => error ? reject(error) : resolve(port)); });
    });
    const key = randomBytes(32).toString('hex');
    const child = this.process = spawn(executable, ['serve', '--asr-model', this.modelPath!, '--host', '127.0.0.1', '--port', String(port), '--no-ui', '--asr.streaming.rnnt_right_context', '3', '--asr.endpointing.enable=true'], {
      cwd: dirname(executable), windowsHide: true, stdio: 'ignore',
      env: { ...process.env, NEMO_SPEECH_HTTP_API_KEY: key },
    });
    // Keep the model's CPU work below interactive app processes when supported.
    if (child.pid) { try { setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* OS policy may prevent changing priority; inference remains isolated. */ } }
    let spawnError = false;
    child.once('error', () => { spawnError = true; });
    child.once('exit', () => { if (this.process === child) { this.server = undefined; this.process = undefined; if (this.session) this.fail(this.session, 'Local dictation stopped unexpectedly. Try again.'); } });
    const deadline = Date.now() + 120000;
    try {
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (spawnError || child.exitCode !== null) throw new Error('The local dictation engine could not load.');
        try {
          const response = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
          if (response.ok && (await response.json()).ready === true) { this.server = { port, key }; return; }
        } catch { signal.throwIfAborted(); }
        await delay(250, undefined, { signal });
      }
      throw new Error('The local dictation engine took too long to load.');
    } catch (error) { child.kill(); if (this.process === child) this.process = undefined; this.server = undefined; throw error; }
  }
  close() { clearTimeout(this.idle); if (this.session) this.cancelSession(this.session); clearTimeout(this.idle); const child = this.process; this.process = undefined; this.server = undefined; child?.kill(); }
}
