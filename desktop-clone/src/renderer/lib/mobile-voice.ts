import type { DesktopBridge, Result } from '../../shared/contracts';
import type { SpeechAudio } from '../../shared/voice';
import type { RemoteClient } from './remote-client';
export type MobileVoiceBridge = Pick<DesktopBridge,'startDictation'|'dictationAudio'|'stopDictation'|'onDictationEvent'|'readAloud'|'nextSpeechAudio'|'cancelSpeech'>;
async function result<T>(operation: () => Promise<T>): Promise<Result<T>> { try { return { ok: true, value: await operation() }; } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Voice connection stopped.' }; } }
export function mobileVoiceBridge(client: () => RemoteClient | null, conversationId: string | (() => Promise<string>)): MobileVoiceBridge {
  const sequences = new Map<string,number>(); let currentDictation = '';
  const jobs = new Map<string, string>();
  const request = async (value: { jobId: string; op: string; [key: string]: unknown }) => { const remote = client(); if (!remote) throw Error('Desktop offline.'); const target = jobs.get(value.jobId) ?? (typeof conversationId === 'string' ? conversationId : await conversationId()); jobs.set(value.jobId, target); return remote.voice({ id: crypto.randomUUID(), conversationId: target, ...value } as Parameters<RemoteClient['voice']>[0]); };
  const audio = (value: any): SpeechAudio => { if (!value || typeof value.audio !== 'string' || value.audio.length > 350000 || !['audio/wav','audio/mpeg'].includes(value.mime)) throw Error('Invalid audio response.'); return { ...value, audio: Uint8Array.from(atob(value.audio),character => character.charCodeAt(0)) }; };
  return {
    startDictation: input => result(async () => { await request({ op: 'dictation-start', jobId: input.id, sampleRate: input.sampleRate }); sequences.set(input.id,0); currentDictation = input.id; }),
    dictationAudio: input => result(async () => { const remote = client(); if (!remote || !sequences.has(input.id) || input.audio.length > 32768) throw Error('Dictation stopped.'); const sequence = sequences.get(input.id)!; sequences.set(input.id,sequence + 1); remote.voiceAudio({ id: crypto.randomUUID(), conversationId: jobs.get(input.id) ?? (typeof conversationId === 'string' ? conversationId : ''), jobId: input.id, op: 'dictation-audio', sequence, audio: btoa(String.fromCharCode(...input.audio)) }); }),
    stopDictation: input => result(async () => { try { await request({ op: 'dictation-stop', jobId: input.id, cancel: input.cancel ?? false }); } finally { sequences.delete(input.id); jobs.delete(input.id); if (currentDictation === input.id) currentDictation = ''; } }),
    onDictationEvent: listener => { const remote = client(); if (!remote) return () => {}; return remote.onVoiceEvent(event => listener(event.id ? event : { ...event, id: currentDictation })); },
    readAloud: input => result(async () => audio(await request({ op: 'speech-read', jobId: input.jobId, messageId: input.messageId, chunk: input.chunk }))),
    nextSpeechAudio: (jobId,sequence) => result(async () => audio(await request({ op: 'speech-next', jobId, sequence }))),
    cancelSpeech: jobId => result(async () => { try { await request({ op: 'speech-cancel', jobId }); } finally { jobs.delete(jobId); } }),
  };
}
