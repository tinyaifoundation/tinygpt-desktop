import { describe, expect, it } from 'vitest';
import { permissionPreset, presetPermissions } from '../src/core/approval-presets';
import { toolPermissionsSchema } from '../src/shared/config';
describe('composer approval presets', () => {
  it('keeps browsing distinct from actions in the automatic browsing preset', () => {
    const rules = presetPermissions('auto'); expect(toolPermissionsSchema.parse(rules)).toEqual(rules);
    expect(rules.browser).toBe('allow'); expect(rules.read).toBe('allow');
    for (const key of ['write', 'execute', 'interact', 'send', 'purchase'] as const) expect(rules[key]).toBe('ask');
  });
  it('recognizes all three presets and preserves a custom or denied rule as custom', () => {
    for (const preset of ['ask', 'auto', 'full'] as const) expect(permissionPreset(presetPermissions(preset))).toBe(preset);
    expect(Object.entries(presetPermissions('full')).filter(([key]) => !['desktop', 'desktopInteract'].includes(key)).every(([,rule]) => rule === 'allow')).toBe(true);
    expect(presetPermissions('full').desktop).toBe('ask'); expect(presetPermissions('full').desktopInteract).toBe('ask');
    expect(presetPermissions('ask').browser).toBe('ask');
    expect(permissionPreset({ ...presetPermissions('auto'), purchase: 'deny' })).toBe('custom');
  });
});
