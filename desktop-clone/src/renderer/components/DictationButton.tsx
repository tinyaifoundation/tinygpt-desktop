import { useAui } from '@assistant-ui/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LoaderCircle, Mic, Square, X } from '../icons';
import type { DesktopBridge } from '../../shared/contracts';
import { dictationPreferencesSchema, type DictationPreferences } from '../../shared/voice';
import type { DictationPhase } from '../../shared/dictation';
import { insertDictation } from '../../core/dictation';
import workletUrl from '../lib/dictation-worklet.js?url&no-inline';
import { Button } from './ui/button';
import { ControlTooltip } from './ui/tooltip';
import { ComposerVoice, type VoiceSample } from './ComposerVoice';

type Capture = {
  id: string; context: AudioContext; media?: MediaStream; node?: AudioWorkletNode;
  source?: MediaStreamAudioSourceNode; sink?: GainNode; disposed: boolean; stopping: boolean;
  before: string; after: string; expected: string;
  queue: Promise<void>; queued: number; flushed?: () => void;
};
export function DictationButton({ bridge, scope, preferences = dictationPreferencesSchema.parse({}), disabled = false, activeChanged, idleControls, stopWhenHidden = false }: {
  bridge: Pick<DesktopBridge, 'startDictation' | 'dictationAudio' | 'stopDictation' | 'onDictationEvent'>; scope: string; preferences?: DictationPreferences; disabled?: boolean; activeChanged: (active: boolean) => void; idleControls?: ReactNode; stopWhenHidden?: boolean;
}) {
  const aui = useAui();
  const button = useRef<HTMLButtonElement>(null);
  const capture = useRef<Capture | null>(null);
  const [phase, setPhase] = useState<DictationPhase | 'idle'>('idle');
  const [audio, setAudio] = useState<{ samples: VoiceSample[]; seconds: number }>({ samples: [], seconds: 0 });
  const [error, setError] = useState('');
  const [anchor, setAnchor] = useState({ left: 0, top: 0 });
  const callbacks = useRef({ aui, activeChanged }); callbacks.current = { aui, activeChanged };

  function release(current: Capture) {
    current.disposed = true;
    current.media?.getTracks().forEach(track => track.stop());
    current.source?.disconnect(); current.node?.disconnect(); current.sink?.disconnect();
    if (current.node) current.node.port.onmessage = null;
    void current.context.close().catch(() => {});
  }
  function cancel() {
    const current = capture.current; if (!current) return;
    capture.current = null; release(current);
    void bridge.stopDictation({ id: current.id, cancel: true });
    callbacks.current.activeChanged(false); setPhase('idle');
  }
  async function stop() {
    const current = capture.current; if (!current || current.stopping) return;
    if (!current.node) { cancel(); return; }
    current.stopping = true; setPhase('finishing');
    // Stop the hardware immediately, then drain the worklet's last short frame.
    current.media?.getTracks().forEach(track => track.stop());
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 500);
      current.flushed = () => { clearTimeout(timer); resolve(); };
      current.node!.port.postMessage('stop');
    });
    await current.queue;
    if (current.disposed) return;
    release(current);
    const result = await bridge.stopDictation({ id: current.id });
    if (capture.current !== current) return;
    capture.current = null; callbacks.current.activeChanged(false); setPhase('idle');
    if (!result.ok) setError('Dictation could not finish. Your current text is kept.');
  }
  async function start() {
    if (capture.current || disabled || !preferences.enabled) return;
    setError(''); setAudio({ samples: [], seconds: 0 }); setPhase('loading'); callbacks.current.activeChanged(true);
    let current: Capture | undefined;
    try {
      const context = new AudioContext({ sampleRate: 16000 });
      const input = button.current?.closest('form')?.querySelector('textarea');
      const draft = callbacks.current.aui.composer().getState().text;
      const start = input?.selectionStart ?? draft.length, end = input?.selectionEnd ?? start;
      current = { id: crypto.randomUUID(), context, disposed: false, stopping: false, before: draft.slice(0, start), after: draft.slice(end), expected: draft, queue: Promise.resolve(), queued: 0 };
      capture.current = current;
      // The model loads exclusively in the native child process before
      // microphone frames are forwarded.
      const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: preferences.echoCancellation, noiseSuppression: preferences.noiseSuppression, ...(preferences.microphoneId ? { deviceId: { exact: preferences.microphoneId } } : {}) }, video: false });
      if (current.disposed) { media.getTracks().forEach(track => track.stop()); return; }
      current.media = media;
      media.getAudioTracks().forEach(track => track.addEventListener('ended', () => { if (!current!.stopping && !current!.disposed) { setError('Your microphone disconnected. Your current text is kept.'); cancel(); } }));
      const ready = await bridge.startDictation({ id: current.id, sampleRate: context.sampleRate });
      if (current.disposed) { void bridge.stopDictation({ id: current.id, cancel: true }); return; }
      if (!ready.ok) throw new Error(ready.error);
      await context.audioWorklet.addModule(workletUrl);
      if (current.disposed) return;
      const node = current.node = new AudioWorkletNode(context, 'tinygpt-dictation');
      current.sink = context.createGain(); current.sink.gain.value = 0;
      current.source = context.createMediaStreamSource(media);
      node.port.onmessage = event => {
        if (current!.disposed) return;
        if (event.data.stopped) { current!.flushed?.(); return; }
        if (!(event.data.pcm instanceof ArrayBuffer)) return;
        const sample = { level: event.data.level as number, at: performance.now() };
        const seconds = event.data.pcm.byteLength / (2 * current!.context.sampleRate);
        setAudio(previous => ({ samples: [sample, ...previous.samples].slice(0, 256), seconds: previous.seconds + seconds }));
        if (++current!.queued > 32) { setError('Dictation could not keep up. Your current text is kept.'); cancel(); return; }
        const audio = new Uint8Array(event.data.pcm);
        current!.queue = current!.queue.then(async () => {
          if (current!.disposed) return;
          const result = await bridge.dictationAudio({ id: current!.id, audio });
          if (!result.ok && !current!.disposed) { setError('Dictation disconnected. Your current text is kept.'); cancel(); }
        }).catch(() => { if (!current!.disposed) { setError('Dictation disconnected. Your current text is kept.'); cancel(); } }).finally(() => { current!.queued--; });
      };
      current.source.connect(node); node.connect(current.sink); current.sink.connect(context.destination);
      await context.resume();
      if (!current.disposed) setPhase('listening');
    } catch (error) {
      if (current && capture.current !== current) return;
      console.warn('Dictation setup failed:', error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown capture error');
      const name = error instanceof Error ? error.name : '';
      setError(name === 'NotAllowedError' ? 'Microphone access is blocked. Allow TinyGPT in your microphone settings and try again.' : name === 'NotFoundError' ? 'No microphone was found. Connect one and try again.' : name === 'NotReadableError' ? 'Your microphone is unavailable. Close other apps using it and try again.' : 'Dictation could not start. Please try again.');
      if (current) cancel(); else { callbacks.current.activeChanged(false); setPhase('idle'); }
    }
  }
  useEffect(() => {
    setPhase('idle'); setError('');
    const unsubscribe = bridge.onDictationEvent(event => {
      const current = capture.current; if (!current || event.id !== current.id) return;
      if (event.phase === 'error') { setError(event.error ?? 'Dictation stopped. Your current text is kept.'); cancel(); return; }
      if (event.phase === 'stopped') return; // stop() settles after the final event.
      setPhase(event.phase);
      if (event.text !== undefined) {
        // A typed edit, send, or external draft replacement wins over late ASR.
        if (callbacks.current.aui.composer().getState().text !== current.expected) { cancel(); return; }
        current.expected = insertDictation(current.before, event.text, current.after);
        callbacks.current.aui.composer().setText(current.expected);
      }
    });
    const form = button.current?.closest('form');
    const input = form?.querySelector('textarea');
    const edit = (event: Event) => {
      const current = capture.current;
      // Let React commit the typed value before changing composer availability;
      // an immediate state update can restore the previous controlled value.
      if (event.isTrusted && current && event.target instanceof HTMLTextAreaElement) {
        const typed = event.target.value;
        queueMicrotask(() => {
          if (capture.current !== current) return;
          callbacks.current.aui.composer().setText(typed);
          cancel();
        });
      }
    };
    const key = (event: KeyboardEvent) => {
      if (!capture.current) return;
      if (event.key === 'Escape' || event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); event.stopPropagation(); void stop(); }
    };
    const submit = (event: Event) => { if (capture.current) { event.preventDefault(); event.stopPropagation(); void stop(); } };
    input?.addEventListener('input', edit, true); form?.addEventListener('keydown', key, true); form?.addEventListener('submit', submit, true);
    return () => {
      unsubscribe(); input?.removeEventListener('input', edit, true); form?.removeEventListener('keydown', key, true); form?.removeEventListener('submit', submit, true);
      const current = capture.current;
      if (current) { capture.current = null; release(current); void bridge.stopDictation({ id: current.id, cancel: true }); callbacks.current.activeChanged(false); }
    };
  }, [bridge, scope]);
  useEffect(() => { if ((disabled || !preferences.enabled) && capture.current) cancel(); }, [disabled, preferences.enabled]);
  useEffect(() => {
    if (!stopWhenHidden) return;
    const hidden = () => { if (document.visibilityState === 'hidden') cancel(); };
    document.addEventListener('visibilitychange',hidden); window.addEventListener('pagehide',cancel);
    return () => { document.removeEventListener('visibilitychange',hidden); window.removeEventListener('pagehide',cancel); };
  },[stopWhenHidden,bridge,scope]);

  const active = phase !== 'idle' && phase !== 'error' && phase !== 'stopped';
  useEffect(() => {
    if (!error) return;
    const position = () => {
      const rect = button.current?.getBoundingClientRect();
      if (rect) setAnchor({ left: Math.max(240, Math.min(window.innerWidth - 12, rect.right)), top: (button.current?.closest('form')?.getBoundingClientRect().top ?? rect.top) - 12 });
    };
    position(); window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
    const observer = new ResizeObserver(position); if (button.current?.closest('form')) observer.observe(button.current.closest('form')!);
    return () => { observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [error]);
  const preparing = phase === 'loading';
  const label = active ? preparing ? 'Cancel dictation setup' : 'Stop dictation' : 'Dictate message';
  const status = phase === 'loading' ? 'Preparing…' : phase === 'finishing' ? 'Transcribing…' : 'Listening';
  if (!preferences.enabled && !active) return <>{idleControls}</>;
  return <div className="dictation-control" data-active={active || undefined}>
    {active ? <ComposerVoice recording={phase === 'listening'} seconds={audio.seconds} samples={audio.samples} status={status} /> : idleControls}
    {error && createPortal(<div className="dictation-overlay" style={{ left: anchor.left, top: anchor.top }}><div role="alert" className="dictation-error"><span>{error}</span><Button type="button" variant="ghost" size="icon" className="size-6 shrink-0" aria-label="Dismiss dictation error" onClick={() => setError('')}><X className="size-3" /></Button></div></div>, document.body)}
    <ControlTooltip label={label}><Button ref={button} type="button" variant="ghost" size="icon" className="dictation-button size-8 rounded-full" aria-label={label} aria-pressed={active} disabled={disabled || phase === 'finishing'} onClick={() => { if (active) void stop(); else void start(); }}>{preparing || phase === 'finishing' ? <LoaderCircle className="size-4 animate-spin" /> : active ? <Square className="size-3 fill-current" /> : <Mic className="size-4" />}</Button></ControlTooltip>
  </div>;
}
