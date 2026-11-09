import { z } from 'zod';

// Only the bundled model's transcription-ready and broad-coverage locales.
export const transcriptionLanguages = { auto: 'Detect automatically', 'en-US': 'English (US)', 'en-GB': 'English (UK)', 'es-US': 'Spanish (US)', 'es-ES': 'Spanish (Spain)', 'fr-FR': 'French', 'fr-CA': 'French (Canada)', 'it-IT': 'Italian', 'pt-BR': 'Portuguese (Brazil)', 'pt-PT': 'Portuguese (Portugal)', 'nl-NL': 'Dutch', 'de-DE': 'German', 'tr-TR': 'Turkish', 'ru-RU': 'Russian', 'ar-AR': 'Arabic', 'hi-IN': 'Hindi', 'ja-JP': 'Japanese', 'ko-KR': 'Korean', 'vi-VN': 'Vietnamese', 'uk-UA': 'Ukrainian', 'pl-PL': 'Polish', 'sv-SE': 'Swedish', 'cs-CZ': 'Czech', 'nb-NO': 'Norwegian Bokmål', 'da-DK': 'Danish', 'bg-BG': 'Bulgarian', 'fi-FI': 'Finnish', 'hr-HR': 'Croatian', 'sk-SK': 'Slovak', 'zh-CN': 'Mandarin', 'hu-HU': 'Hungarian', 'ro-RO': 'Romanian', 'et-EE': 'Estonian' } as const;
export const dictationPreferencesSchema = z.object({ enabled: z.boolean().default(true), language: z.enum(Object.keys(transcriptionLanguages) as [keyof typeof transcriptionLanguages, ...Array<keyof typeof transcriptionLanguages>]).default('auto'), automaticPunctuation: z.boolean().default(true), pauseMs: z.number().int().min(200).max(3000).default(800), microphoneId: z.string().max(256).default(''), noiseSuppression: z.boolean().default(true), echoCancellation: z.boolean().default(true) }).strict();
export const speechSelectionSchema = z.object({ connectionId: z.uuid(), model: z.string().min(1).max(200) }).strict();
export const readAloudPreferencesSchema = z.object({ enabled: z.boolean().default(false), selection: speechSelectionSchema.optional(), voice: z.string().max(200).default(''), speed: z.number().min(0.5).max(2).default(1) }).strict();
export const voicePreferencesSchema = z.object({ dictation: dictationPreferencesSchema.default(dictationPreferencesSchema.parse({})), readAloud: readAloudPreferencesSchema.default(readAloudPreferencesSchema.parse({})) }).strict();
export type DictationPreferences = z.infer<typeof dictationPreferencesSchema>;
export type ReadAloudPreferences = z.infer<typeof readAloudPreferencesSchema>;
export type SpeechSelection = z.infer<typeof speechSelectionSchema>;
export interface SpeechModel extends SpeechSelection { name: string; provider: string; voices: string[]; format: 'mp3' | 'pcm' }
export const pocketConnection = '00000000-0000-4000-8000-000000000083';
export const pocketVoices = ['alba', 'marius', 'javert', 'jean', 'fantine', 'cosette', 'eponine', 'azelma'];
export interface CustomSpeechVoice { id: string; name: string; createdAt: string }
export interface SpeechCatalog { models: SpeechModel[]; issues: string[]; customVoices?: CustomSpeechVoice[]; }
export interface SpeechAudio { audio: Uint8Array; mime: 'audio/mpeg' | 'audio/wav'; chunks: number; stream?: { sampleRate: number; done: boolean } }
export const speechStreamRequestSchema = z.object({ jobId: z.uuid(), sequence: z.number().int().min(1).max(1000000) }).strict();
export function speechVoiceDisplay(voice: string): { name: string; country?: 'US' | 'GB' } {
  const match = /^([ab])[fm]_(.+)$/i.exec(voice);
  const name = (match?.[2] ?? voice).replace(/[_-]+/g, ' ').replace(/\b[a-z]/g, letter => letter.toUpperCase());
  return { name, ...(match ? { country: match[1].toLowerCase() === 'a' ? 'US' as const : 'GB' as const } : {}) };
}
export const speechRequestSchema = z.object({ conversationId: z.uuid(), messageId: z.uuid(), jobId: z.uuid(), chunk: z.number().int().min(0).max(5000).default(0) }).strict();
export type SpeechRequest = z.infer<typeof speechRequestSchema>;
