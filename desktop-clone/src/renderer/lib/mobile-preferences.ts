import {z} from 'zod';
export const mobilePreferencesSchema=z.object({textSize:z.number().int().min(15).max(22).default(18),speed:z.number().min(.5).max(2).default(1),readAloud:z.boolean().default(true),dictation:z.boolean().default(true),noiseSuppression:z.boolean().default(true),echoCancellation:z.boolean().default(true)}).strict();
export type MobilePreferences=z.infer<typeof mobilePreferencesSchema>;
export function readMobilePreferences():MobilePreferences{try{return mobilePreferencesSchema.parse(JSON.parse(localStorage.getItem('tinygpt-mobile-preferences')??'{}'));}catch{return mobilePreferencesSchema.parse({});}}
export function saveMobilePreferences(value:MobilePreferences){const parsed=mobilePreferencesSchema.parse(value);try{localStorage.setItem('tinygpt-mobile-preferences',JSON.stringify(parsed));}catch{}applyMobilePreferences(parsed);return parsed;}
export function applyMobilePreferences(value=readMobilePreferences()){document.documentElement.style.setProperty('--mobile-text-size',value.textSize+'px');}
