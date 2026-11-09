import model from './dictation-model.json';
export type DictationPhase = 'loading' | 'listening' | 'finishing' | 'stopped' | 'error';
export interface DictationEvent {
  id: string;
  phase: DictationPhase;
  text?: string;
  error?: string;
}
export const dictationModel = model;
