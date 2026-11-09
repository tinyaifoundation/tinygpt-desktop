import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import type { BotConfiguration } from '../shared/bot';

/** Keep native preferences/persona while refreshing the private transport. */
export function nativeBotConfig(previous: Record<string, any>, managed: Record<string, any>, profile: string, root: string, name: string, choices: BotConfiguration) {
  const entries = { ...previous.agents?.entries };
  entries.main = { ...entries.main, identity: { ...entries.main?.identity, name } };
  const plugins = previous.plugins ?? {};
  return { ...previous, ...managed,
    browser: { ...previous.browser, enabled: choices.browser, headless: true },
    cron: { ...previous.cron, enabled: choices.background },
    plugins: { ...plugins, enabled: true, allow: [...new Set([...(plugins.allow ?? []).filter((id: string) => id !== 'memory-core' || choices.memory), 'tinygpt-bridge', ...(choices.memory ? ['memory-core'] : [])])],
      load: { ...plugins.load, paths: [...new Set([...(plugins.load?.paths ?? []), join(root, 'tinygpt-bridge')])] },
      slots: { ...plugins.slots, memory: choices.memory ? 'memory-core' : 'none' }, entries: { ...plugins.entries, 'tinygpt-bridge': { enabled: true, hooks: { allowConversationAccess: true } } } },
    tools: { ...previous.tools, profile: 'full', allow: undefined, toolSearch: false, alsoAllow: [...new Set([...(previous.tools?.alsoAllow ?? []), 'tinygpt_action'])],
      // Runtime management stays in the host; it must not overwrite our transport.
      deny: [...new Set([...(previous.tools?.deny ?? []).filter((id: string) => !['*', 'gateway', 'cron'].includes(id)), 'gateway', 'openclaw', ...(choices.background ? [] : ['cron'])])],
      elevated: { ...previous.tools?.elevated, enabled: false },
      loopDetection: { ...previous.tools?.loopDetection, enabled: true },
      fs: { ...previous.tools?.fs, workspaceOnly: choices.files === 'workspace' },
      exec: { ...previous.tools?.exec, host: 'gateway', mode: choices.commands, notifyOnExit: choices.background,
        applyPatch: { ...previous.tools?.exec?.applyPatch, workspaceOnly: choices.files === 'workspace' } } },
    agents: { ...previous.agents, entries, defaults: { ...previous.agents?.defaults, ...managed.agents.defaults,
      workspace: join(profile, 'workspace'), skipBootstrap: true, models: undefined, memorySearch: undefined,
      heartbeat: { ...previous.agents?.defaults?.heartbeat, every: choices.background && choices.heartbeat !== 'off' ? choices.heartbeat : '0m' },
      compaction: { ...previous.agents?.defaults?.compaction, memoryFlush: { ...previous.agents?.defaults?.compaction?.memoryFlush, enabled: choices.memory } },
      } },
    memory: { ...previous.memory, search: { ...previous.memory?.search, enabled: choices.memory } },
  };
}

export async function syncBotIdentity(profile: string, name: string, runtimeRoot?: string) {
  const workspace = join(profile, 'workspace'); await mkdir(workspace, { recursive: true });
  if (runtimeRoot) for (const file of ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'USER.md', 'HEARTBEAT.md']) {
    try { const template = await readFile(join(runtimeRoot, 'node_modules/openclaw/docs/reference/templates', file), 'utf8'); const body = template.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''); await writeFile(join(workspace, file), body, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (!['EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
  const path = join(workspace, 'IDENTITY.md'); let text: string;
  try { text = await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; text = '# IDENTITY.md\n\n- **Name:** Your Bot\n'; }
  const line = `- **Name:** ${name.replace(/[\r\n]/g, ' ')}`;
  text = /^- \*\*Name:\*\*.*$/m.test(text) ? text.replace(/^- \*\*Name:\*\*.*$/m, () => line) : `${text.trimEnd()}\n\n${line}\n`;
  await writeFile(path, text, { mode: 0o600 });
}
