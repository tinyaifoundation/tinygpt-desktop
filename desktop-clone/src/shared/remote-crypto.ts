import Noise from 'noise-handshake';
import Cipher from 'noise-handshake/cipher.js';
import * as bytes from 'b4a';

export const REMOTE_TRANSPORT = 'tinygpt.remote.v2';
export const REMOTE_FRAME_LIMIT = 100000;
export type SecureRoute = { desktopId: string; grantId: string; deviceId: string; connectionId: string };
const hex32 = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_MESSAGE = 1000000, CHUNK = 55000, MAX_FRAMES = 1000000;
export function validSecureRoute(route: SecureRoute) { return hex32.test(route.desktopId) && [route.grantId, route.deviceId, route.connectionId].every(value => uuid.test(value)); }
export function keyContext(desktopId: string, grantId: string) { return `TinyGPT remote v2 pairing:${desktopId}:${grantId}`; }
function decode(text: string, max: number) {
  if (typeof text !== 'string' || text.length > max || !text.length || text.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw Error('Invalid encrypted frame.');
  return bytes.from(text, 'base64');
}

// Noise NNpsk0 authenticates both endpoints with a QR-only, per-device PSK.
// Its ephemeral X25519 exchange provides fresh directional transport keys.
// The relay never receives this PSK. Routing is bound into the transcript.
export class RemoteCipher {
  private handshake?: Noise;
  private tx?: Cipher; private rx?: Cipher;
  private chunks: Uint8Array[] = []; private length = 0; private started = 0;
  private sent = 0; private received = 0; private destroyed = false;
  constructor(private initiator: boolean, psk: string, readonly route: SecureRoute) {
    if (!hex32.test(psk) || !validSecureRoute(route)) throw Error('Invalid secure pairing.');
    this.handshake = new Noise('NNpsk0', initiator, undefined, { psk: bytes.from(psk, 'hex') });
    this.handshake.initialise(bytes.from(JSON.stringify([REMOTE_TRANSPORT, route.desktopId, route.grantId, route.deviceId, route.connectionId])));
  }
  get ready() { return !!this.tx && !!this.rx && !this.destroyed; }
  start() { if (!this.initiator || !this.handshake || this.destroyed) throw Error('Invalid handshake.'); return bytes.toString(this.handshake.send(), 'base64'); }
  handshakeMessage(text: string): string | undefined {
    try {
      const state = this.handshake; if (!state || this.destroyed) throw Error('Unexpected handshake.');
      if (state.recv(decode(text, 1024)).length) throw Error('Unexpected handshake payload.');
      const reply = this.initiator ? undefined : bytes.toString(state.send(), 'base64');
      if (!state.complete) throw Error('Incomplete handshake.');
      this.tx = new Cipher(state.tx); this.rx = new Cipher(state.rx);
      state.s?.secretKey.fill(0); state.e?.secretKey.fill(0); state.psk?.fill(0);
      this.handshake = undefined;
      return reply;
    } catch { this.destroy(); throw Error('Secure connection could not be verified. Pair again.'); }
  }
  seal(value: unknown): string[] {
    try {
      if (!this.ready) throw Error('Secure connection is not ready.');
      const data = bytes.from(JSON.stringify(value)); if (!data.length || data.length > MAX_MESSAGE) throw Error('Message too large.');
      const frames: string[] = [];
      for (let offset = 0; offset < data.length; offset += CHUNK) {
        if (++this.sent > MAX_FRAMES) throw Error('Renew the secure connection.');
        const chunk = data.subarray(offset, offset + CHUNK), frame = bytes.alloc(chunk.length + 1);
        frame[0] = offset + CHUNK >= data.length ? 1 : 0; frame.set(chunk, 1);
        frames.push(bytes.toString(this.tx!.encrypt(frame), 'base64'));
      }
      return frames;
    } catch (error) { this.destroy(); throw error; }
  }
  open(text: string): unknown | undefined {
    try {
      if (!this.ready || ++this.received > MAX_FRAMES) throw Error('Renew the secure connection.');
      const frame = this.rx!.decrypt(decode(text, REMOTE_FRAME_LIMIT));
      if (frame.length < 2 || frame.length > CHUNK + 1 || frame[0] > 1 || this.chunks.length >= 19 || this.started && Date.now() - this.started > 30000) throw Error('Invalid encrypted message.');
      this.started ||= Date.now(); this.length += frame.length - 1;
      if (this.length > MAX_MESSAGE) throw Error('Message too large.');
      this.chunks.push(frame.subarray(1)); if (!frame[0]) return;
      const value = JSON.parse(bytes.toString(bytes.concat(this.chunks)));
      this.chunks = []; this.length = 0; this.started = 0; return value;
    } catch { this.destroy(); throw Error('Encrypted message authentication failed.'); }
  }
  destroy() {
    this.destroyed = true; this.tx?._clear(); this.rx?._clear(); this.tx = this.rx = undefined;
    const state = this.handshake;
    if (state) { state.s?.secretKey.fill(0); state.e?.secretKey.fill(0); state.psk?.fill(0); }
    this.handshake = undefined; for (const chunk of this.chunks) chunk.fill(0); this.chunks = []; this.length = 0;
  }
}
