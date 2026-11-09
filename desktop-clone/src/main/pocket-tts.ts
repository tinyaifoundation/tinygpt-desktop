import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, mkdir, stat, readdir, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { PocketWaveDecoder } from '../core/pocket-audio';
import { pocketVoices, type CustomSpeechVoice } from '../shared/voice';

export const pocketErrors = ['Pocket TTS could not start. Prepare the voice runtime and try again.', 'Pocket TTS could not generate speech. Try again.', 'This voice is unavailable.', 'Pocket TTS returned unsupported audio.', 'Pocket TTS returned incomplete audio.'];
const metadata = z.object({ id: z.uuid(), name: z.string().min(1).max(60), createdAt: z.iso.datetime() }).strict();
export class PocketTTS {
  private server?: ChildProcess;
  private ready?: Promise<string>;
  private idle?: ReturnType<typeof setTimeout>;
  private active = 0;
  private epoch = 0;
  private voiceServer?: Server;
  private voiceAddress = '';
  private voiceFiles = new Map<string, string>();
  private voiceCache = new Set<string>();
  private readonly assets: string;
  private readonly voices: string;
  constructor(root: string, private profile: string, private request: typeof fetch = fetch, private keepLoaded: () => boolean = () => false) { this.assets = join(root, 'pocket-tts'); this.voices = join(profile, 'pocket-voices'); }
  processIds(): number[] { return [this.server].flatMap(child => child?.pid && child.exitCode === null && child.signalCode === null ? [child.pid] : []); }
  private get executable() { return join(this.assets, process.platform === 'win32' ? 'pocket-tts.exe' : 'pocket-tts'); }
  async listVoices(): Promise<CustomSpeechVoice[]> {
    const files = await readdir(this.voices).catch(() => []);
    const values = await Promise.all(files.filter(file => /^[0-9a-f-]{36}\.json$/.test(file)).map(async file => {
      try { const voice = metadata.parse(JSON.parse(await readFile(join(this.voices, file), 'utf8'))); if (file !== `${voice.id}.json` || !(await stat(join(this.voices, `${voice.id}.safetensors`))).size) return []; return [voice]; } catch { return []; }
    }));
    return values.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  private async config(): Promise<string> {
    await mkdir(join(this.profile, 'pocket-model'), { recursive: true });
    const config = parse(await readFile(join(this.assets, 'config.template.yaml'), 'utf8'));
    config.weights_path = join(this.assets, 'model.safetensors');
    delete config.weights_path_without_voice_cloning;
    config.flow_lm.lookup_table.tokenizer_path = join(this.assets, 'tokenizer.json');
    const path = join(this.profile, 'pocket-model', 'speech.yaml'); await writeFile(path, stringify(config)); return path;
  }
  warm(): Promise<string> {
    clearTimeout(this.idle);
    if (!this.ready) {
      const ready = this.start().catch(error => { if (this.ready === ready) this.ready = undefined; throw error; });
      this.ready = ready;
      void ready.then(() => this.unloadLater(), () => {});
    }
    return this.ready;
  }
  private async start(): Promise<string> {
    const epoch = this.epoch;
    const config = await this.config().catch(() => { throw Error(pocketErrors[0]); });
    if (epoch !== this.epoch) throw Error(pocketErrors[0]);
    const secret = randomUUID(), voiceServer = this.voiceServer = createServer((request, response) => {
      const file = this.voiceFiles.get(request.url ?? '');
      if (request.method !== 'GET' || !file) { response.writeHead(404).end(); return; }
      void readFile(file).then(bytes => { response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length }); response.end(bytes); }, () => response.writeHead(404).end());
    });
    await new Promise<void>((resolve, reject) => { voiceServer.once('error', reject); voiceServer.listen(0, '127.0.0.1', () => { voiceServer.removeListener('error', reject); resolve(); }); });
    if (epoch !== this.epoch) { voiceServer.close(); throw Error(pocketErrors[0]); }
    const address = voiceServer.address(); if (!address || typeof address === 'string') throw Error(pocketErrors[0]);
    this.voiceAddress = `http://127.0.0.1:${address.port}/${secret}`;
    return new Promise((resolve, reject) => {
      const server = this.server = spawn(this.executable, ['serve', '--host', '127.0.0.1', '--port', '0', '--config', config, '--default-voice', join(this.assets, 'voices/alba.safetensors')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: this.profile, USERPROFILE: this.profile, NO_COLOR: '1', FIRST_CHUNK_LENGTH_SECONDS: '0' } });
      let logs = '', settled = false;
      const timer = setTimeout(() => { server.kill(); reject(Error(pocketErrors[0])); }, 90000);
      const inspect = (bytes: Buffer) => { logs = (logs + bytes.toString()).slice(-4000); const match = /Server running on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs); if (match && !settled) { settled = true; clearTimeout(timer); resolve(match[1]); } };
      server.stdout?.on('data', inspect); server.stderr?.on('data', inspect);
      server.once('error', () => { clearTimeout(timer); voiceServer.close(); reject(Error(pocketErrors[0])); });
      server.once('exit', () => { clearTimeout(timer); voiceServer.closeAllConnections(); voiceServer.close(); if (this.server === server) { this.server = undefined; this.ready = undefined; this.voiceServer = undefined; this.clearVoiceCache(); } if (!settled) reject(Error(pocketErrors[0])); });
    });
  }
  private unloadLater() { if (!this.active) this.idle = setTimeout(() => this.keepLoaded() ? this.unloadLater() : this.closeServer(), 180000); }
  async *stream(text: string, voice: string, signal: AbortSignal): AsyncGenerator<{ audio: Uint8Array; sampleRate: number }> {
    signal.throwIfAborted(); this.active++; clearTimeout(this.idle);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const path = pocketVoices.includes(voice) ? join(this.assets, 'voices', `${voice}.safetensors`) : (await this.listVoices()).some(item => item.id === voice) ? join(this.voices, `${voice}.safetensors`) : undefined;
      if (!path) throw Error(pocketErrors[2]);
      const address = await this.warm(); signal.throwIfAborted();
      // The native server's multipart limit is smaller than exported voice states.
      // Serve allowlisted local states over a private, unguessable loopback URL.
      const voiceUrl = `${this.voiceAddress}/${voice}.safetensors`; this.voiceFiles.set(new URL(voiceUrl).pathname, path);
      this.voiceCache.add(join(this.profile, '.cache/pocket_tts', createHash('sha256').update(voiceUrl).digest('hex') + '.safetensors'));
      const response = await this.request(`${address}/tts`, { method: 'POST', body: new URLSearchParams({ text, voice_url: voiceUrl }), signal, redirect: 'error' });
      if (!response.ok || !response.body) throw Error(pocketErrors[1]);
      reader = response.body.getReader(); const decoder = new PocketWaveDecoder();
      while (true) { signal.throwIfAborted(); const result = await reader.read(); if (result.done) break; const audio = decoder.push(result.value); if (audio.length) yield { audio, sampleRate: decoder.sampleRate }; }
      decoder.finish();
    } finally { await reader?.cancel().catch(() => {}); this.active--; this.unloadLater(); }
  }
  private clearVoiceCache() { this.voiceFiles.clear(); for (const file of this.voiceCache) void unlink(file).catch(() => {}); this.voiceCache.clear(); }
  private closeServer() { this.epoch++; clearTimeout(this.idle); this.ready = undefined; const server = this.server; this.server = undefined; server?.kill(); this.voiceServer?.closeAllConnections(); this.voiceServer?.close(); this.voiceServer = undefined; this.clearVoiceCache(); }
  close() { this.closeServer(); }
}
