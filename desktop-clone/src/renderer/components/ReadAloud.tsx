import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { LoaderCircle, Pause, Play, Square, Volume2 } from '../icons';
import type { DesktopBridge } from '../../shared/contracts';
import type { ReadAloudPreferences } from '../../shared/voice';
import { useSpeechPlayback } from '../hooks/useSpeechPlayback';
import { Button } from './ui/button';
import { ControlTooltip } from './ui/tooltip';

const ReadAloudContext = createContext<{ playback: ReturnType<typeof useSpeechPlayback>; enabled: boolean; read: (messageId: string) => void } | null>(null);
export function ReadAloudProvider({ bridge, conversationId, preferences, children, stopWhenHidden = false }: { bridge: Pick<DesktopBridge, 'readAloud' | 'cancelSpeech' | 'nextSpeechAudio'>; conversationId: string | null; preferences: ReadAloudPreferences; children: ReactNode; stopWhenHidden?: boolean }) {
  const playback = useSpeechPlayback(bridge, `${conversationId ?? ''}:${JSON.stringify(preferences)}`, preferences.speed, stopWhenHidden);
  return <ReadAloudContext.Provider value={{ playback, enabled: preferences.enabled, read: messageId => { if (conversationId && preferences.enabled) void playback.start(messageId, (jobId, chunk) => bridge.readAloud({ conversationId, messageId, jobId, chunk })); } }}>{children}</ReadAloudContext.Provider>;
}
export function ReadAloudButton({ messageId, disabled }: { messageId: string; disabled?: boolean }) {
  const value = useContext(ReadAloudContext), current = value?.playback.state.target === messageId;
  const latest = useRef(value); latest.current = value;
  // Playback belongs to the conversation provider. Scrolling a virtualized
  // message out of view must not stop it; provider scope changes handle cleanup.
  if (!value?.enabled) return null;
  const { playback } = value, phase = current ? playback.state.phase : 'idle', loading = phase === 'loading', playing = phase === 'playing', paused = phase === 'paused';
  const label = loading ? 'Stop read aloud' : playing ? 'Pause read aloud' : paused ? 'Resume read aloud' : 'Read aloud';
  return <><ControlTooltip label={label}><Button variant="ghost" size="icon" className="message-control size-7 rounded-full text-muted-foreground" aria-label={label} disabled={disabled && !current} onClick={() => loading ? playback.stop() : playing ? playback.pause() : paused ? playback.resume() : value.read(messageId)}>{loading ? <LoaderCircle className="size-3.5 animate-spin" /> : playing ? <Pause className="size-3.5" /> : paused ? <Play className="size-3.5" /> : <Volume2 className="size-3.5" />}</Button></ControlTooltip>{(playing || paused) && <ControlTooltip label="Stop read aloud"><Button variant="ghost" size="icon" className="message-control size-7 rounded-full text-muted-foreground" aria-label="Stop read aloud" onClick={playback.stop}><Square className="size-3" /></Button></ControlTooltip>}{current && playback.state.error && <span role="alert" className="max-w-sm text-xs text-destructive">{playback.state.error}</span>}</>;
}
