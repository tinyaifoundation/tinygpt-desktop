import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopBridge, Result } from '../../shared/contracts';
import type { SpeechAudio } from '../../shared/voice';
import { prefetchedSpeech } from '../../core/speech-playback';
import { StreamingSpeechPlayer } from './streaming-speech';

export function useSpeechPlayback(bridge: Pick<DesktopBridge, 'cancelSpeech' | 'nextSpeechAudio'>, scope: string, speed = 1, stopWhenHidden = false) {
  const active = useRef<{ id: string; target: string; audio?: HTMLAudioElement; pcm?: StreamingSpeechPlayer; url?: string; settle?: () => void } | null>(null);
  const [state, setState] = useState<{ target: string; phase: 'idle' | 'loading' | 'playing' | 'paused' | 'error'; error: string }>({ target: '', phase: 'idle', error: '' });
  const stop = useCallback(() => {
    const current = active.current; active.current = null;
    if (current) { current.pcm?.dispose(); current.audio?.pause(); if (current.audio) current.audio.src = ''; if (current.url) URL.revokeObjectURL(current.url); current.settle?.(); void bridge.cancelSpeech(current.id).catch(() => {}); }
    setState({ target: '', phase: 'idle', error: '' });
  }, [bridge]);
  useEffect(() => { stop(); return stop; }, [scope, stop]);
  useEffect(() => {
    if (!stopWhenHidden) return;
    const hidden = () => { if (document.visibilityState === 'hidden') stop(); };
    document.addEventListener('visibilitychange',hidden); window.addEventListener('pagehide',stop);
    return () => { document.removeEventListener('visibilitychange',hidden); window.removeEventListener('pagehide',stop); };
  },[stopWhenHidden,stop]);
  const start = useCallback(async (target: string, request: (id: string, chunk: number) => Promise<Result<SpeechAudio>>) => {
    stop(); const current = { id: crypto.randomUUID(), target } as NonNullable<typeof active.current>; active.current = current;
    try {
      setState({ target, phase: 'loading', error: '' });
      current.pcm = new StreamingSpeechPlayer(speed, phase => { if (active.current === current) setState({ target, phase, error: '' }); });
      await current.pcm.ready(); if (active.current !== current) return;
      const prepared = prefetchedSpeech(chunk => request(current.id, chunk), () => active.current === current);
      for await (const result of prepared) {
        if (active.current !== current) return;
        if (result.stream) {
          let part = result, sequence = 1;
          const alive = () => active.current === current;
          while (alive()) {
            if (part.audio.length) current.pcm!.append(part.audio, part.stream!.sampleRate);
            if (part.stream!.done) break;
            await current.pcm!.room(alive); if (!alive()) return;
            const next = await bridge.nextSpeechAudio(current.id, sequence++);
            if (!alive()) return; if (!next.ok) throw Error(next.error); part = next.value;
            if (!part.stream) throw Error('Pocket TTS returned incomplete audio.');
          }
          await current.pcm!.finish(alive); break;
        }
        current.pcm?.dispose(); current.pcm = undefined;
        current.url = URL.createObjectURL(new Blob([Uint8Array.from(result.audio)], { type: result.mime }));
        const audio = current.audio = new Audio(current.url); audio.playbackRate = speed; audio.preservesPitch = true;
        await new Promise<void>((resolve, reject) => {
          current.settle = resolve; audio.onended = () => resolve(); audio.onerror = () => reject(Error('The spoken audio could not be played. Try another voice or model.'));
          void audio.play().then(() => { if (active.current === current) setState({ target, phase: 'playing', error: '' }); }, () => reject(Error('Audio playback could not start. Press Read aloud to try again.')));
        });
        audio.pause(); audio.src = ''; URL.revokeObjectURL(current.url); current.url = undefined; current.audio = undefined; current.settle = undefined;
        if (active.current === current) setState({ target, phase: 'loading', error: '' });
      }
      if (active.current === current) { current.pcm?.dispose(); active.current = null; setState({ target: '', phase: 'idle', error: '' }); }
    } catch (error) {
      if (active.current !== current) return; stop(); setState({ target, phase: 'error', error: error instanceof Error ? error.message : 'Read aloud could not finish.' });
    }
  }, [bridge, speed, stop]);
  const pause = useCallback(() => { const current = active.current; if (current?.audio || current?.pcm) { current.audio?.pause(); current.pcm?.pause(); setState({ target: current.target, phase: 'paused', error: '' }); } }, []);
  const resume = useCallback(() => { const current = active.current; if (current?.audio || current?.pcm) void (current.pcm ? current.pcm.resume() : current.audio!.play()).then(() => { if (active.current === current) setState({ target: current.target, phase: 'playing', error: '' }); }, () => { stop(); setState({ target: current.target, phase: 'error', error: 'Audio playback could not resume.' }); }); }, [stop]);
  return { state, start, stop, pause, resume };
}
