import type { PluginSnapshot } from './plugins';
import overrides from './tool-icon-overrides.json';

const connectorGroups: Record<string, readonly string[]> = {
  gmail: ['gmail'], gdrive: ['google-drive'], gcalendar: ['google-calendar'],
  github: ['github'], slack: ['slack'], google: ['gmail', 'google-drive'],
};

/** Match the host's UUID-scoped extension aliases, including saved calls whose
 * connector is currently disconnected. Never match another plugin by name alone. */
export async function connectorToolIconKeys(snapshot: PluginSnapshot): Promise<Record<string, string>> {
  const keys: Record<string, string> = {};
  await Promise.all(snapshot.entries.flatMap(entry => {
    const groups = connectorGroups[entry.manifest.connector ?? ''] ?? [];
    const skills = entry.manifest.skills ?? [];
    const localNames = new Set<string>();
    if (skills.length) localNames.add('load_skill');
    if (skills.some(skill => Object.keys(skill.references).length)) localNames.add('read_skill_reference');
    if (entry.manifest.kind === 'builtin' && entry.manifest.id === 'tinygpt-reports') localNames.add('create_report');
    if (entry.manifest.server) { localNames.add('tinygpt_read_resource'); localNames.add('tinygpt_get_prompt'); }
    return Object.keys(overrides).filter(key => groups.includes(key.split('/')[0]) || key.startsWith('plugin/') && localNames.has(key.slice('plugin/'.length))).map(async key => {
      const originalName = key.slice(key.indexOf('/') + 1);
      const readable = originalName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 34) || 'tool';
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${entry.id}\0${originalName}`));
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 24);
      keys[`ext_${readable}_${hash}`] = key;
    });
  }));
  return keys;
}
