import { describe, expect, it } from 'vitest';
import { appearanceSchema, defaultAppearance, paletteSchema } from '../src/renderer/lib/appearance';

describe('appearance font preference migration', () => {
  it('migrates legacy UI/content fonts without resetting unrelated appearance preferences', () => {
    const legacy = { ...defaultAppearance, theme: 'dark', pointerCursors: true, uiFontSize: 17,
      light: { ...defaultAppearance.light, uiFont: 'Georgia', contentFont: 'Arial', accent: '#8b5cf6', translucentSidebar: true },
      dark: { ...defaultAppearance.dark, uiFont: 'Satoshi', contentFont: 'Same as UI font', background: '#191919', codeFont: 'Menlo', codeWeight: 'Medium' } };
    const migrated = appearanceSchema.parse(legacy);
    expect(migrated.light).toEqual({ ...legacy.light, uiFont: 'Figtree', contentFont: 'Figtree' });
    expect(migrated.dark).toEqual({ ...legacy.dark, uiFont: 'Figtree', contentFont: 'Figtree' });
    expect(migrated.theme).toBe('dark'); expect(migrated.pointerCursors).toBe(true); expect(migrated.uiFontSize).toBe(17);
    expect(appearanceSchema.parse(migrated)).toEqual(migrated);
  });
  it('imports legacy theme palettes but still rejects unknown font names', () => {
    expect(paletteSchema.parse({ ...defaultAppearance.light, uiFont: 'System default', contentFont: 'Same as UI font' })).toMatchObject({ uiFont: 'Figtree', contentFont: 'Figtree' });
    expect(paletteSchema.safeParse({ ...defaultAppearance.light, uiFont: 'url(https://example.org/font)' }).success).toBe(false);
  });
});
