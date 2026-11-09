import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HistoryStore } from '../src/main/history';

const profile = resolve(process.env.TINYGPT_VOICE_PROFILE!);
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
const history = new HistoryStore(join(profile, 'library.sqlite'));
const chat = history.createConversation(null);
const turn = history.startTurn(chat.id, 'Settings fixture', 'local');
history.saveReply(turn.assistantId, 'Settings fixture answer', 'complete');
for (const name of ['calculate', 'code_grep', 'computer_read_window'] as const) {
  const id = randomUUID(); history.addTool(id, chat.id, turn.runId, name, 'Fixture tool'); history.finishTool(id, 'success', '{}');
}
history.close();
app.on('browser-window-created', (_event, window) => window.hide());
require('../out/main/index.js');
