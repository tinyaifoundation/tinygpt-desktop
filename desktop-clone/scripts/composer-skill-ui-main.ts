import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HistoryStore } from '../src/main/history';
import { PluginStore } from '../src/main/plugin-store';
import { parseSkill } from '../src/core/plugin-skills';
import { defaultSettings } from '../src/shared/config';
import { pocketConnection } from '../src/shared/voice';

const profile = resolve(process.env.TINYGPT_VOICE_PROFILE!);
mkdirSync(profile, { recursive: true }); app.setPath('userData', profile);
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ ...defaultSettings, route: 'local', local: { ...defaultSettings.local, endpoint: 'http://127.0.0.1:9/v1', model: 'composer-fixture', tools: true }, mode: 'code', voice: { ...defaultSettings.voice, readAloud: { ...defaultSettings.voice.readAloud, selection: { connectionId: pocketConnection, model: 'pocket-tts' }, voice: 'alba' } } }));
const history = new HistoryStore(join(profile, 'library.sqlite'));
const other = history.createProject('Other scope', '');
for (const title of ['Conversation reference one', 'Conversation reference two']) {
  const source = history.createConversation(null, 'chat'); history.renameConversation(source.id, title);
  const turn = history.startTurn(source.id, title, 'local'); history.saveReply(turn.assistantId, `${title} remains saved.`, 'complete');
}
const chat = history.createConversation(null, 'code');
const turn = history.startTurn(chat.id, 'Composer fixture', 'byok');
history.saveReply(turn.assistantId, 'Composer fixture ready.', 'complete'); history.close();
app.on('browser-window-created', (_event, window) => window.hide());
void (async () => {
  const plugins = new PluginStore(profile, { available: () => true, encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  await plugins.load();
  for (const fixture of [
    { id: 'fixture-brief', name: 'brief', description: 'Write a concise brief.' },
    { id: 'fixture-review', name: 'review', description: 'Review supplied work.' },
    { id: 'fixture-duplicate-one', name: 'duplicate', description: 'First duplicate skill.' },
    { id: 'fixture-duplicate-two', name: 'duplicate', description: 'Second duplicate skill.' },
    { id: 'fixture-disabled', name: 'disabled-skill', description: 'Disabled skill.', enabled: false },
    { id: 'fixture-denied', name: 'denied-skill', description: 'Denied skill.', denied: true },
    { id: 'fixture-other-mode', name: 'bot-only', description: 'Bot-only skill.', bot: true },
    { id: 'fixture-other-project', name: 'other-project', description: 'Another Project.', scoped: true },
  ]) {
    await plugins.save({ manifest: { format: 1, id: fixture.id, name: fixture.name, version: '1.0.0', description: fixture.description, kind: 'skill', modes: fixture.bot ? ['bot'] : ['chat', 'code'], skills: [parseSkill(`---\nname: ${fixture.name}\ndescription: ${fixture.description}\n---\nUse the supplied evidence.`)], dependencies: [] }, config: { enabled: fixture.enabled !== false, projectIds: fixture.scoped ? [other.id] : null, rules: { load_skill: fixture.denied ? 'deny' : 'allow' }, resources: [] } });
  }
  require('../out/main/index.js');
})();
