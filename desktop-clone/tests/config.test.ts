import { describe, expect, it } from 'vitest';
import { defaultSettings, endpointSchema, settingsSchema } from '../src/shared/config';

describe('configuration boundary', () => {
  it('accepts separate output budgets and keeps old settings compatible', () => {
    expect(settingsSchema.parse(defaultSettings).byok.maxOutputTokens).toBeUndefined();
    expect(settingsSchema.parse({ ...defaultSettings, byok: { ...defaultSettings.byok, maxOutputTokens: 16000 } }).byok.maxOutputTokens).toBe(16000);
    for (const maxOutputTokens of [0, 127, 128001, 1000.5]) expect(settingsSchema.safeParse({ ...defaultSettings, local: { ...defaultSettings.local, maxOutputTokens } }).success).toBe(false);
  });
  it.each(['http://127.0.0.1:11434/v1', 'http://localhost:1234/v1', 'http://[::1]:1234/v1', 'https://api.example.com/v1'])('accepts supported API address %s', endpoint => {
    expect(endpointSchema.safeParse(endpoint).success).toBe(true);
  });
  it.each(['file:///etc/passwd', 'http://api.example.com/v1', 'https://user:password@api.example.com', 'https://api.example.com?key=secret', 'https://api.example.com/#secret', 'not a URL'])('rejects unsafe or credential-bearing address %s', endpoint => {
    expect(endpointSchema.safeParse(endpoint).success).toBe(false);
  });
  it('rejects unknown top-level fields rather than persisting a plaintext key', () => {
    expect(settingsSchema.safeParse({ ...defaultSettings, apiKey: 'plaintext-secret' }).success).toBe(false);
  });
  it('rejects secrets added inside a provider object', () => {
    expect(settingsSchema.safeParse({ ...defaultSettings, byok: { ...defaultSettings.byok, apiKey: 'secret' } }).success).toBe(false);
  });
  it('restores approval defaults for older settings', () => {
    const { toolPermissions: _permissions, ...legacy } = defaultSettings;
    expect(settingsSchema.parse(legacy).toolPermissions.execute).toBe('ask');
  });
});
