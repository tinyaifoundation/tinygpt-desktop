import { describe, it, expect } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { RemoteCipher } from '../src/shared/remote-crypto';
const route = () => ({ desktopId: 'a'.repeat(64), grantId: randomUUID(), deviceId: randomUUID(), connectionId: randomUUID() });
function pair() { const psk = randomBytes(32).toString('hex'), ids = route(), phone = new RemoteCipher(true, psk, ids), desktop = new RemoteCipher(false, psk, ids); phone.handshakeMessage(desktop.handshakeMessage(phone.start())!); return { phone, desktop, psk, ids }; }
describe('Remote Control end-to-end channel', () => {
  it('round-trips messages, large snapshots, files, images and voice without readable content in frames', () => {
    const { phone, desktop } = pair();
    for (const value of [{text:'PRIVATE_MESSAGE'}, {file:'PRIVATE_FILENAME',data:'PRIVATE_FILE'.repeat(30000)}, {image:'PRIVATE_IMAGE'.repeat(3000)}, {audio:'PRIVATE_VOICE'.repeat(5000)}]) {
      const frames = phone.seal(value); expect(frames.join('')).not.toContain('PRIVATE_'); let decoded: unknown;
      for (const frame of frames) decoded = desktop.open(frame); expect(decoded).toEqual(value);
      const reply = desktop.seal({ok:true}); expect(phone.open(reply[0])).toEqual({ok:true});
    }
  });
  it('rejects another QR secret, forged routing and old-session handshake responses', () => {
    const { psk, ids } = pair(), phone = new RemoteCipher(true, psk, ids), wrong = new RemoteCipher(false, 'b'.repeat(64), ids);
    expect(() => wrong.handshakeMessage(phone.start())).toThrow('verified');
    const changed = new RemoteCipher(false, psk, {...ids,deviceId:randomUUID()}), fresh = new RemoteCipher(true, psk, ids);
    expect(() => changed.handshakeMessage(fresh.start())).toThrow('verified');
    const first = new RemoteCipher(true, psk, ids), server = new RemoteCipher(false, psk, ids), response = server.handshakeMessage(first.start())!;
    const second = new RemoteCipher(true, psk, ids); second.start(); expect(() => second.handshakeMessage(response)).toThrow('verified');
  });
  it('rejects alteration, duplication, out-of-order frames and cross-session ciphertext', () => {
    for (const mode of ['alter','duplicate','order','session']) {
      const { phone, desktop } = pair(), first = phone.seal({private:'one'})[0], second = phone.seal({private:'two'})[0];
      if (mode === 'duplicate') { desktop.open(first); expect(() => desktop.open(first)).toThrow('authentication'); }
      if (mode === 'order') expect(() => desktop.open(second)).toThrow('authentication');
      if (mode === 'session') { const other = pair().desktop; expect(() => other.open(first)).toThrow('authentication'); desktop.destroy(); }
      if (mode === 'alter') { const data = Buffer.from(first,'base64'); data[4] ^= 1; expect(() => desktop.open(data.toString('base64'))).toThrow('authentication'); }
      expect(desktop.ready).toBe(false);
    }
  });
  it('fails closed before handshake and after destruction, and bounds assembled content', () => {
    const { phone, desktop } = pair(); expect(() => phone.seal({x:'x'.repeat(1000001)})).toThrow('large'); expect(phone.ready).toBe(false);
    desktop.destroy(); desktop.destroy(); expect(() => desktop.open('AAAA')).toThrow();
    const pending = new RemoteCipher(true,'a'.repeat(64),route()); expect(() => pending.seal({x:1})).toThrow('ready');
  });
  it('requires a fresh session before the transport nonce range could wrap', () => {
    const {phone} = pair(); (phone as any).sent = 1000000;
    expect(()=>phone.seal({text:'must not reuse a nonce'})).toThrow('Renew'); expect(phone.ready).toBe(false);
  });
});
