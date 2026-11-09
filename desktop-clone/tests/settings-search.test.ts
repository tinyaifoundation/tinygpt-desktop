import { describe, expect, it } from 'vitest';
import { normalizeSettingsSearch, searchSettings, settingsSearchEntries } from '../src/renderer/lib/settings-search';

describe('settings content search', () => {
  it('finds controls by descriptions and common terms before visiting their sections', () => {
    const cases = [
      ['noise suppression', 'Voice', 'Reduce background noise'],
      ['ad blocker', 'Browser', 'TinyGPT AdBlock'],
      ['vram', 'Configuration', 'Graphics memory'],
      ['speech into a draft', 'Voice', 'Bundled transcription'],
      ['quiet hou', 'Notifications', 'Use quiet hours'],
      ['openrouter training', 'Configuration', 'Allow data collection'],
      ['indexing', 'Personalization', 'Project folders'],
      ['screen recording', 'Computer use', 'Mac permissions'],
      ['system sleep', 'Remote Control', 'Keep this computer awake'],
      ['bot heartbeat', 'Bot', 'Check in periodically'],
    ];
    for (const [query, section, title] of cases) expect(searchSettings(query), query).toEqual(expect.arrayContaining([expect.objectContaining({ section, title })]));
  });
  it('prioritizes exact setting names and matches section names as well', () => {
    expect(searchSettings('First name')[0]).toMatchObject({ section: 'Profile', title: 'First name' });
    expect(searchSettings('Default search engine')[0]).toMatchObject({ section: 'Browser', title: 'Default search engine' });
    expect(searchSettings('appearance').every(entry => entry.section === 'Appearance')).toBe(true);
    expect(searchSettings('work effort')[0]).toMatchObject({ section: 'Work settings', title: 'Work effort' });
  });
  it('normalizes case, accents, punctuation and multiple spaces without treating query text as code', () => {
    expect(normalizeSettingsSearch('  RÉDUCE—Motion! ')).toBe('reduce motion');
    expect(searchSettings('  UNREAD    DOTS ')[0].title).toBe('Unread dots');
    expect(searchSettings('only when youre away')[0].title).toBe('Only when you’re away');
    expect(searchSettings('[')).toEqual([]);
    expect(searchSettings('')).toEqual([]);
    expect(searchSettings('setting-that-does-not-exist')).toEqual([]);
  });
  it('covers every active section with stable, unique result identities and safe navigation actions', () => {
    expect(new Set(settingsSearchEntries.map(entry => entry.id)).size).toBe(settingsSearchEntries.length);
    expect(new Set(settingsSearchEntries.map(entry => entry.section))).toEqual(new Set(['General', 'Configuration', 'Notifications', 'Profile', 'Appearance', 'Voice', 'Personalization', 'Computer use', 'Remote Control', 'Plugins', 'Browser', 'Work settings', 'Bot', 'Keyboard shortcuts', 'Archived chats', 'Diagnostics']));
    expect(settingsSearchEntries.filter(entry => entry.open).every(entry => ['Configuration', 'Profile', 'Plugins'].includes(entry.section))).toBe(true);
    expect(settingsSearchEntries.find(entry => entry.title === 'Quiet from')?.open).toBeUndefined();
  });
});
