import { app } from 'electron';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HistoryStore } from '../src/main/history';

const profile = process.env.TINYGPT_TOOLS_PROFILE!;
mkdirSync(profile, { recursive: true }); app.setPath('userData', profile);
if (process.env.TINYGPT_SAVED_UI_FIXTURE) {
  const history = new HistoryStore(join(profile, 'library.sqlite'));
  const chat = history.createConversation(null); history.renameConversation(chat.id, 'Saved font comparison');
  const turn = history.startTurn(chat.id, 'Show the saved font comparison.', 'local');
  history.saveReply(turn.assistantId, 'Saved research summary.', 'complete', null);
  const toolId = randomUUID(); history.addTool(toolId, chat.id, turn.runId, 'present', 'Present an interface');
  history.finishTool(toolId, 'success', JSON.stringify({ ui: JSON.parse(readFileSync(process.env.TINYGPT_SAVED_UI_FIXTURE, 'utf8')) }));
  history.close();
}
app.on('browser-window-created', (_event, window) => window.hide());
require('../out/main/index.js');
