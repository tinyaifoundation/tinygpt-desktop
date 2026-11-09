import { useEffect, useState } from 'react';
import { z } from 'zod';
import { botDesignSchema, defaultBotDesign } from './bot';

const color = z.string().regex(/^#[\da-f]{6}$/i);
export const displayFonts = ['Inter', 'Geist', 'Figtree', 'Public Sans', 'Manrope', 'Roboto', 'DM Sans', 'Plus Jakarta Sans'] as const;
type DisplayFont = typeof displayFonts[number];
const legacyFonts = ['System default', 'Same as UI font', 'Arial', 'Georgia', 'Menlo', 'Satoshi'] as const;
const displayFont = z.enum([...displayFonts, ...legacyFonts]);
const codeFont = z.enum(['System default', 'Same as UI font', 'Inter', 'Arial', 'Georgia', 'Menlo']);
function currentDisplayFont(font: z.infer<typeof displayFont>): DisplayFont { return (displayFonts as readonly string[]).includes(font) ? font as DisplayFont : 'Figtree'; }
const weight = z.enum(['Light', 'Regular', 'Medium', 'Semibold', 'Bold']);
// Retain the stored translucency key for existing preferences and theme files.
export const paletteSchema = z.object({ accent: color, background: color, foreground: color, uiFont: displayFont, uiWeight: weight, contentFont: displayFont, contentWeight: weight, codeFont, codeWeight: weight, translucentSidebar: z.boolean(), contrast: z.number().min(0).max(100) }).strict().transform(palette => {
  const uiFont = currentDisplayFont(palette.uiFont);
  return { ...palette, uiFont, contentFont: palette.contentFont === 'Same as UI font' ? uiFont : currentDisplayFont(palette.contentFont) };
});
export type ThemePalette = z.infer<typeof paletteSchema>;
const light: ThemePalette = { accent: '#3478f6', background: '#ffffff', foreground: '#1a1c1f', uiFont: 'Figtree', uiWeight: 'Regular', contentFont: 'Figtree', contentWeight: 'Regular', codeFont: 'Menlo', codeWeight: 'Regular', translucentSidebar: false, contrast: 50 };
const dark: ThemePalette = { ...light, accent: '#4c84fa', background: '#171717', foreground: '#ededef' };
export const appearanceSchema = z.object({ theme: z.enum(['system', 'light', 'dark']), light: paletteSchema, dark: paletteSchema, pointerCursors: z.boolean(), dockIcon: z.enum(['ios-default', 'dark', 'tinted-light', 'clear-light', 'clear-dark']).default('ios-default'), reduceMotion: z.enum(['system', 'on', 'off']), uiFontSize: z.number().min(11).max(20), codeFontSize: z.number().min(10).max(24), diffMarkers: z.enum(['color', 'symbols']).default('color'), fontSmoothing: z.boolean() }).strict();
export type Appearance = z.infer<typeof appearanceSchema>;
export type Profile = { name: string; handle: string; avatar: string; firstName?: string; lastName?: string };
export const profileSchema = z.object({ name: z.string().trim().min(1).max(121), firstName: z.string().trim().max(60).optional(), lastName: z.string().trim().max(60).optional(), handle: z.string().max(30).regex(/^[\w.-]*$/), avatar: z.union([z.literal(''), z.string().max(2800000).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z\d+/=]+$/)]) }).strict();
export function profileNames(profile: Profile) {
  if (profile.firstName !== undefined || profile.lastName !== undefined) return { firstName: profile.firstName ?? '', lastName: profile.lastName ?? '' };
  const [firstName = '', ...rest] = profile.name.toLowerCase() === 'personal' ? [] : profile.name.trim().split(/\s+/);
  return { firstName, lastName: rest.join(' ') };
}
export const defaultAppearance: Appearance = { theme: 'light', light, dark, pointerCursors: false, dockIcon: 'ios-default', reduceMotion: 'system', uiFontSize: 14, codeFontSize: 12, diffMarkers: 'color', fontSmoothing: true };
const families = { 'System default': 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', 'Same as UI font': 'Inter, sans-serif', Inter: 'Inter, sans-serif', Satoshi: 'Satoshi, sans-serif', Geist: '"Geist Variable", sans-serif', Figtree: '"Figtree Variable", sans-serif', 'Public Sans': '"Public Sans Variable", sans-serif', Manrope: '"Manrope Variable", sans-serif', Roboto: '"Roboto Variable", sans-serif', 'DM Sans': '"DM Sans Variable", sans-serif', 'Plus Jakarta Sans': '"Plus Jakarta Sans Variable", sans-serif', Arial: 'Arial, sans-serif', Georgia: 'Georgia, serif', Menlo: 'Menlo, "Cascadia Code", monospace' };
const weights = { Light: '300', Regular: '400', Medium: '500', Semibold: '600', Bold: '700' };
export function appearanceVariables(appearance: Appearance, theme: 'light' | 'dark') {
  const palette = appearance[theme];
  return { '--background': palette.background, '--foreground': palette.foreground, '--user-accent': palette.accent, '--ring': palette.accent, '--user-ui-font': families[palette.uiFont], '--user-content-font': families[palette.contentFont], '--user-code-font': families[palette.codeFont], '--user-ui-weight': weights[palette.uiWeight], '--user-content-weight': weights[palette.contentWeight], '--user-code-weight': weights[palette.codeWeight], '--user-ui-size': `${appearance.uiFontSize}px`, '--user-code-size': `${appearance.codeFontSize}px`, '--user-ui-scale': String(appearance.uiFontSize / 14), '--user-contrast': String(0.75 + palette.contrast / 200) };
}
function stored<T>(key: string, schema: z.ZodType<T>, fallback: T): T { try { return schema.parse(JSON.parse(localStorage.getItem(key) ?? 'null')); } catch { return structuredClone(fallback); } }
export function initials(profile: Profile) { return profile.name.split(/\s+/).map(word => word[0]).join('').slice(0, 2).toUpperCase(); }
export function useDesktopPreferences() {
  const [bot, setBot] = useState(() => stored('tinygpt-bot-v4', botDesignSchema, defaultBotDesign));
  useEffect(() => { try { localStorage.setItem('tinygpt-bot-v4', JSON.stringify(bot)); } catch { /* Design remains usable this session. */ } }, [bot]);
  const [appearance, setAppearance] = useState(() => {
    const saved = stored('tinygpt-appearance-v4', appearanceSchema, defaultAppearance);
    try {
      if (!localStorage.getItem('tinygpt-figtree-default-v1')) {
        for (const palette of [saved.light, saved.dark]) {
          if (palette.uiFont === 'Inter') palette.uiFont = 'Figtree';
          if (palette.contentFont === 'Inter') palette.contentFont = 'Figtree';
        }
        localStorage.setItem('tinygpt-figtree-default-v1', '1');
      }
    } catch { /* The new default still applies when storage is unavailable. */ }
    return saved;
  });
  const [profile, setProfile] = useState(() => stored('tinygpt-profile-v4', profileSchema, { name: 'Personal', handle: '', avatar: '' }));
  useEffect(() => { try { localStorage.setItem('tinygpt-profile-v4', JSON.stringify(profile)); } catch { /* Profile remains usable this session. */ } }, [profile]);
  useEffect(() => {
    if (profile.firstName !== undefined || profile.lastName !== undefined || profile.name.toLowerCase() === 'personal') return;
    let migrated = false;
    try { migrated = localStorage.getItem('tinygpt-profile-name-memory-v1') === '1'; } catch { return; }
    if (migrated || !window.tinygpt?.saveProfileName) return;
    void window.tinygpt.saveProfileName(profileNames(profile)).then(result => {
      if (result.ok) try { localStorage.setItem('tinygpt-profile-name-memory-v1', '1'); } catch { /* The saved memory remains durable. */ }
    }).catch(() => { /* A busy app can retry the migration on its next launch. */ });
  }, [profile]);
  useEffect(() => { void window.tinygpt?.setAppIcon(appearance.dockIcon); }, [appearance.dockIcon]);
  useEffect(() => {
    try { localStorage.setItem('tinygpt-appearance-v4', JSON.stringify(appearance)); } catch { /* Preferences remain usable this session. */ }
    const systemTheme = matchMedia('(prefers-color-scheme: dark)'); const systemMotion = matchMedia('(prefers-reduced-motion: reduce)');
    function apply() {
      const theme = appearance.theme === 'system' ? systemTheme.matches ? 'dark' : 'light' : appearance.theme;
      const palette = appearance[theme]; const root = document.documentElement;
      root.dataset.theme = theme; root.dataset.pointer = String(appearance.pointerCursors); root.dataset.smoothing = String(appearance.fontSmoothing);
      root.dataset.motion = appearance.reduceMotion === 'on' || (appearance.reduceMotion === 'system' && systemMotion.matches) ? 'reduce' : 'full';
      root.dataset.diffMarkers = appearance.diffMarkers;
      root.dataset.translucent = String(palette.translucentSidebar);
      root.style.colorScheme = theme;
      const variables = appearanceVariables(appearance, theme);
      for (const [key, value] of Object.entries(variables)) root.style.setProperty(key, value);
      window.dispatchEvent(new Event('tinygpt-motion'));
    }
    apply(); systemTheme.addEventListener('change', apply); systemMotion.addEventListener('change', apply);
    return () => { systemTheme.removeEventListener('change', apply); systemMotion.removeEventListener('change', apply); };
  }, [appearance]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (!event.newValue) return;
      try {
        const value = JSON.parse(event.newValue);
        if (event.key === 'tinygpt-appearance-v4') setAppearance(appearanceSchema.parse(value));
        if (event.key === 'tinygpt-profile-v4') setProfile(profileSchema.parse(value));
        if (event.key === 'tinygpt-bot-v4') setBot(botDesignSchema.parse(value));
      } catch { /* Ignore invalid or incomplete preferences from another window. */ }
    };
    window.addEventListener('storage', sync); return () => window.removeEventListener('storage', sync);
  }, []);
  return { appearance, setAppearance, profile, setProfile, bot, setBot };
}
