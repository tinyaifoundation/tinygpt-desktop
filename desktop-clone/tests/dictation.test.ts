import { expect, it } from 'vitest';
import { DictationTranscript, insertDictation } from '../src/core/dictation';

it('replaces provisional text with authoritative finals across endpointed utterances', () => {
  const transcript = new DictationTranscript();
  expect(transcript.accept({ type: 'session.created' })).toBeUndefined();
  expect(transcript.accept({ type: 'conversation.item.input_audio_transcription.delta', delta: 'hello' })).toBe('hello');
  expect(transcript.accept({ type: 'conversation.item.input_audio_transcription.delta', delta: ' world' })).toBe('hello world');
  expect(transcript.accept({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hello, world.' })).toBe('Hello, world.');
  expect(transcript.accept({ type: 'conversation.item.input_audio_transcription.delta', delta: 'Next sentence' })).toBe('Hello, world. Next sentence');
  expect(transcript.accept({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Next sentence.' })).toBe('Hello, world. Next sentence.');
  expect(transcript.accept({ type: 'conversation.item.input_audio_transcription.completed', transcript: '' })).toBe('Hello, world. Next sentence.');
});
it('inserts at the selection and preserves surrounding whitespace and the draft limit', () => {
  expect(insertDictation('Before', 'new words', 'after')).toBe('Before new words after');
  expect(insertDictation('Before\n', 'new words', '\nafter')).toBe('Before\nnew words\nafter');
  expect(insertDictation('', 'Hello.', '')).toBe('Hello.');
  expect(insertDictation('1234', 'words', '789', 12)).toBe('1234 wor 789');
  expect(insertDictation('1234', 'words', '789', 7)).toBe('1234789');
});
