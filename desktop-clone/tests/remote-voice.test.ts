import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RemoteVoiceBridge } from '../src/main/remote-voice';
import { pocketConnection, type SpeechAudio, type SpeechRequest } from '../src/shared/voice';
import { remoteVoiceRequestSchema } from '../src/shared/remote-voice';

function setup() {
  const dictation = { start: vi.fn(async () => {}), audio: vi.fn(), stop: vi.fn(async () => {}) };
  const audio: SpeechAudio = { audio: new Uint8Array(48), mime: 'audio/wav', chunks: 1, stream: { sampleRate: 24000, done: false } };
  const speech = { preview:vi.fn(async()=>audio),read: vi.fn(async (_request: SpeechRequest, _owner: number) => audio), nextStream: vi.fn(async () => audio), cancel: vi.fn(), cancelOwner: vi.fn() };
  const preferences = { dictation: { enabled: true }, readAloud: { enabled: true, speed: 1, selection: { connectionId: pocketConnection, model: 'pocket-tts' } } };
  const bridge = new RemoteVoiceBridge(dictation,speech,() => preferences);
  const peer = { deviceId: randomUUID(),connectionId: randomUUID(),conversationId: randomUUID() }, jobId = randomUUID();
  const request = (op: string, values = {}) => remoteVoiceRequestSchema.parse({ id: randomUUID(),conversationId: peer.conversationId,jobId,op,...values });
  return { bridge,dictation,speech,preferences,peer,jobId,request,audio };
}
it('accepts ordered bounded PCM frames and rejects replayed or malformed audio',async () => {
  const f = setup();
  try {
    await f.bridge.handle(f.peer,f.request('dictation-start',{ sampleRate: 16000 }));
    const frame = f.request('dictation-audio',{ sequence: 0,audio: Buffer.alloc(2560).toString('base64') });
    await f.bridge.handle(f.peer,frame); await expect(f.bridge.handle(f.peer,frame)).rejects.toThrow();
    await expect(f.bridge.handle(f.peer,f.request('dictation-audio',{ sequence: 1,audio: Buffer.alloc(3).toString('base64') }))).rejects.toThrow();
    expect(f.dictation.audio).toHaveBeenCalledTimes(1);
  } finally { f.bridge.close(); }
});
it('isolates microphone sessions between tabs and releases owners on revocation',async () => {
  const f = setup();
  await f.bridge.handle(f.peer,f.request('dictation-start',{ sampleRate: 16000 }));
  const owner = (f.dictation.start.mock.calls[0] as unknown as [string,number,{ isDestroyed(): boolean }])[2];
  await expect(f.bridge.handle({ ...f.peer,connectionId: randomUUID() },f.request('dictation-stop'))).rejects.toThrow();
  expect(f.dictation.stop).not.toHaveBeenCalled();
  f.bridge.cancelDevice(f.peer.deviceId); expect(owner.isDestroyed()).toBe(true); expect(f.speech.cancelOwner).toHaveBeenCalled();
});
it('keeps remote read aloud local and never falls back to a paid provider',async () => {
  const f = setup(); f.preferences.readAloud.selection.connectionId = randomUUID();
  try { expect(f.bridge.capabilities().readAloud).toBe(false); await expect(f.bridge.handle(f.peer,f.request('speech-read',{ messageId: randomUUID(),chunk: 0 }))).rejects.toThrow(); expect(f.speech.read).not.toHaveBeenCalled(); } finally { f.bridge.close(); }
});
it('previews only the selected local voice with device-owned streaming and cancellation',async()=>{const f=setup();try{await f.bridge.handle(f.peer,f.request('speech-preview'));expect(f.speech.preview).toHaveBeenCalledOnce();await f.bridge.handle(f.peer,f.request('speech-cancel'));expect(f.speech.cancel).toHaveBeenCalled();f.preferences.readAloud.selection.connectionId=randomUUID();await expect(f.bridge.handle(f.peer,f.request('speech-preview'))).rejects.toThrow();expect(f.speech.preview).toHaveBeenCalledOnce();}finally{f.bridge.close();}});
it('uses the authorized conversation and a distinct owner for speech',async () => {
  const f = setup(), messageId = randomUUID();
  try {
    const value = await f.bridge.handle(f.peer,f.request('speech-read',{ messageId,chunk: 0 })) as { audio: string };
    expect(Buffer.from(value.audio,'base64')).toHaveLength(48);
    expect(f.speech.read.mock.calls[0][0]).toMatchObject({ conversationId: f.peer.conversationId,messageId });
    await expect(f.bridge.handle({ ...f.peer,connectionId: randomUUID() },f.request('speech-next',{ sequence: 1 }))).rejects.toThrow();
    expect(f.speech.nextStream).not.toHaveBeenCalled();
  } finally { f.bridge.close(); }
});
it('can cancel speech while synthesis is pending and discards its late result',async () => {
  const f = setup(); let finish!: (audio: SpeechAudio) => void;
  f.speech.read.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.bridge.handle(f.peer,f.request('speech-read',{ messageId: randomUUID(),chunk: 0 }));
  await f.bridge.handle(f.peer,f.request('speech-cancel')); expect(f.speech.cancel).toHaveBeenCalled();
  finish(f.audio); await expect(pending).rejects.toThrow('stopped'); f.bridge.close();
});
