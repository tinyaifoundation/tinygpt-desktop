import { afterEach, expect, it, vi } from 'vitest';
const { engine } = vi.hoisted(() => ({ engine: { warm: vi.fn(async () => {}), start: vi.fn(async () => {}), cancel: vi.fn(), close: vi.fn(), stop: vi.fn(), audio: vi.fn() } }));
vi.mock('../src/main/moonshine-speech', () => ({ Speech: class { warm = engine.warm; start = engine.start; cancel = engine.cancel; close = engine.close; stop = engine.stop; audio = engine.audio; } }));
import { MoonshineDictation } from '../src/main/moonshine-dictation';
import { LocalVisionService } from '../src/main/local-vision';
import { defaultSettings } from '../src/shared/config';
import { MemoryService } from '../src/main/memory-service';
import { HistoryStore } from '../src/main/history';
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
it('unloads ASR after three idle minutes, protects active dictation and honors keep loaded', async () => {
  vi.useFakeTimers(); let keep = false;
  const service = new MoonshineDictation('unused', () => defaultSettings.voice.dictation, () => keep);
  const owner = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), removeListener: vi.fn() };
  await service.start('first', 16000, owner); await vi.advanceTimersByTimeAsync(240000); expect(engine.close).not.toHaveBeenCalled();
  await service.stop('first', owner, true); await vi.advanceTimersByTimeAsync(179999); expect(engine.close).not.toHaveBeenCalled();
  keep = true; await vi.advanceTimersByTimeAsync(1); expect(engine.close).not.toHaveBeenCalled();
  keep = false; await vi.advanceTimersByTimeAsync(180000); expect(engine.close).toHaveBeenCalledOnce();
  await service.start('second', 16000, owner); expect(engine.warm).toHaveBeenCalledTimes(2); service.close();
});
it('keeps idle vision loaded when requested, then releases it and reloads on demand', async () => {
  vi.useFakeTimers(); let keep = true;
  const close = vi.fn(async () => {}), load = vi.fn(async () => ({ analyze: async () => ({ observation: 'fixture', incomplete: false }), close }));
  const service = new LocalVisionService({ modelRoot: '', runtimeRoot: '', stateRoot: '', idleMs: 30000, load, keepLoaded: () => keep });
  let request = 0;
  const analyze = () => service.analyze('data:image/png;base64,AA==',`Describe ${request++}`,new AbortController().signal);
  await analyze(); await vi.advanceTimersByTimeAsync(60000); expect(close).not.toHaveBeenCalled();
  keep = false; await vi.advanceTimersByTimeAsync(30000); expect(close).toHaveBeenCalledOnce();
  await analyze(); expect(load).toHaveBeenCalledTimes(2); await service.close();
});
it('does not cancel ASR idle release when a disabled microphone start is rejected', async () => {
  vi.useFakeTimers(); let enabled = true;
  const service = new MoonshineDictation('unused', () => ({ ...defaultSettings.voice.dictation, enabled }));
  const owner = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), removeListener: vi.fn() };
  await service.start('first', 16000, owner); await service.stop('first', owner, true); enabled = false;
  await expect(service.start('disabled', 16000, owner)).rejects.toThrow('Enable transcription');
  await vi.advanceTimersByTimeAsync(180000); expect(engine.close).toHaveBeenCalledOnce(); service.close();
});
it('unloads retrieval when idle, keeps keyword search usable, and wakes without loading on read denial', async () => {
  vi.useFakeTimers(); const history = new HistoryStore(':memory:'); let allowed = true;
  const load = vi.fn(async () => {}), close = vi.fn(), runtime = { load, close, embed: vi.fn(async () => []) };
  const service = new MemoryService(history, runtime, () => allowed, () => {}, () => false, () => ({ idleMinutes: 1 }));
  try {
    const chat = history.createConversation(null); history.sources.add(chat.id, { kind: 'page', title: 'Evidence', text: 'ORCHID keyword evidence' });
    history.sources.setExcluded(chat.id, history.sources.list(chat.id)[0].id, true);
    await service.initialize(); await vi.advanceTimersByTimeAsync(60000); service.kick(); expect(service.snapshot().semantic.status).toBe('off'); expect(close).toHaveBeenCalledOnce();
    allowed = false; service.warm(); expect(await service.search(chat.id, 'ORCHID')).toEqual([]); expect(load).toHaveBeenCalledOnce();
    allowed = true; history.sources.setExcluded(chat.id, history.sources.list(chat.id)[0].id, false);
    expect((await service.search(chat.id, 'ORCHID'))[0].text).toContain('keyword evidence'); expect(load).toHaveBeenCalledTimes(2);
  } finally { await service.shutdown(); history.close(); }
});
