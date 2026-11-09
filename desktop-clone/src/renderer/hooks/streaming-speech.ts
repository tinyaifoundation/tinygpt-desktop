/** Bounded PCM playback queue. Pulling stops at two seconds of lookahead so
 * generation and IPC cannot buffer an entire long answer in the renderer. */
export class StreamingSpeechPlayer {
  // Resample the continuous output bus, rather than each short PCM packet, and
  // give the device a playback-sized buffer instead of an interactive deadline.
  private context: AudioContext;
  private next = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private disposed = false;
  private started = false;
  private signal = false;
  paused = false;
  constructor(private speed: number, private changed?: (state: 'playing' | 'paused') => void) {
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) { try { session.type = 'playback'; } catch { /* Older browsers use their supported audio policy. */ } }
    this.context = new AudioContext({ sampleRate: 24000, latencyHint: 'playback' });
    this.context.onstatechange = () => { if (!this.started || this.disposed) return; if (this.context.state !== 'running') { this.paused = true; this.changed?.('paused'); } else if (!this.paused && this.signal && this.sources.size) this.changed?.('playing'); };
  }
  async ready() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.context.resume(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Audio playback could not start. Tap Read aloud to try again.')), 5000); })]); if (this.context.state !== 'running') throw Error('Audio playback is paused by your browser. Tap Read aloud to try again.'); this.started = true; }
    finally { clearTimeout(timer); }
  }
  private async tick(alive: () => boolean) { await new Promise(resolve => setTimeout(resolve, 25)); if (!alive() || this.disposed) throw Error('Read aloud was stopped.'); }
  async room(alive: () => boolean) { while (this.paused || this.next - this.context.currentTime > 2) await this.tick(alive); }
  append(bytes: Uint8Array, sampleRate: number) {
    if (this.disposed || !bytes.length) return;
    if (bytes.length % 2 || sampleRate !== 24000) throw Error('Pocket TTS returned unsupported audio.');
    const samples = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), buffer = this.context.createBuffer(1, bytes.length / 2, sampleRate), output = buffer.getChannelData(0);
    for (let index = 0; index < output.length; index++) { output[index] = samples.getInt16(index * 2, true) / 32768; if (Math.abs(output[index]) > .0001) this.signal = true; }
    const source = this.context.createBufferSource(); source.buffer = buffer; source.playbackRate.value = this.speed; source.connect(this.context.destination);
    // Keep queued packets contiguous, even when the lead is temporarily small.
    // Adding a fresh startup delay to every packet inserts gaps into speech.
    if (this.next <= this.context.currentTime) this.next = this.context.currentTime + Math.max(.04, this.context.baseLatency * 2);
    source.start(this.next); this.next += buffer.duration / this.speed;
    this.sources.add(source); source.onended = () => { this.sources.delete(source); source.disconnect(); };
    if (this.started && !this.paused && this.context.state === 'running' && this.signal) this.changed?.('playing');
  }
  async finish(alive: () => boolean) { if (!this.signal) throw Error('The speech audio was silent. Try Read aloud again.'); while (this.sources.size || this.paused) await this.tick(alive); }
  pause() { this.paused = true; void this.context.suspend().catch(() => {}); }
  async resume() { await this.ready(); this.paused = false; if (this.signal && this.sources.size) this.changed?.('playing'); }
  dispose() { if (this.disposed) return; this.disposed = true; for (const source of this.sources) { source.stop(); source.disconnect(); } this.sources.clear(); void this.context.close().catch(() => {}); }
}
