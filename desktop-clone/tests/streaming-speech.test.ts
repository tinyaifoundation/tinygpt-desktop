import { afterEach, expect, it, vi } from 'vitest';
import { StreamingSpeechPlayer } from '../src/renderer/hooks/streaming-speech';
let context: FakeContext; let fail = false, staySuspended = false;
class FakeContext {
  state = 'suspended'; currentTime = 0; baseLatency = .01; destination = {}; onstatechange?: () => void; sources: any[] = []; values?: Float32Array;
  constructor() { context = this; }
  async resume() { if (fail) throw Error('Browser refused playback'); if (!staySuspended) this.state = 'running'; this.onstatechange?.(); }
  async suspend() { this.state = 'suspended'; this.onstatechange?.(); }
  async close() { this.state = 'closed'; }
  createBuffer(_channels: number, count: number, rate: number) { this.values = new Float32Array(count); return { duration: count / rate, getChannelData: () => this.values! }; }
  createBufferSource() { const source = { playbackRate: { value: 1 }, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() }; this.sources.push(source); return source; }
}
function setup() { fail = false; staySuspended = false; const session = { type: 'ambient' }; vi.stubGlobal('navigator', { audioSession: session }); vi.stubGlobal('AudioContext', FakeContext); const changed = vi.fn(); const player = new StreamingSpeechPlayer(1, changed); return { session, changed, player }; }
afterEach(() => vi.unstubAllGlobals());
it('selects media playback and reports playing only for running, non-silent PCM', async () => { const f = setup(); expect(f.session.type).toBe('playback'); f.player.append(new Uint8Array(4), 24000); expect(f.changed).not.toHaveBeenCalled(); await f.player.ready(); f.player.append(Uint8Array.from([0, 32, 0, 224]), 24000); expect(context.values).toEqual(Float32Array.from([.25, -.25])); expect(f.changed).toHaveBeenLastCalledWith('playing'); f.player.dispose(); });
it('surfaces rejected or suspended browser starts instead of pretending to play', async () => { const f = setup(); fail = true; await expect(f.player.ready()).rejects.toThrow('Browser refused'); expect(f.changed).not.toHaveBeenCalled(); fail = false; staySuspended = true; await expect(f.player.ready()).rejects.toThrow('paused by your browser'); f.player.dispose(); });
it('exposes interruptions as paused and resumes through an explicit action', async () => { const f = setup(); await f.player.ready(); f.player.append(Uint8Array.from([0, 32]), 24000); context.state = 'interrupted'; context.onstatechange?.(); expect(f.changed).toHaveBeenLastCalledWith('paused'); expect(f.player.paused).toBe(true); await f.player.resume(); expect(f.player.paused).toBe(false); expect(f.changed).toHaveBeenLastCalledWith('playing'); f.player.dispose(); });
it('rejects an entirely silent speech result and invalid PCM framing', async () => { const f = setup(); await f.player.ready(); f.player.append(new Uint8Array(8), 24000); await expect(f.player.finish(() => true)).rejects.toThrow('silent'); expect(() => f.player.append(new Uint8Array(3), 24000)).toThrow('unsupported'); f.player.dispose(); });
