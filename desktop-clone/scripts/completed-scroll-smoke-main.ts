import { app, BrowserWindow } from 'electron';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HistoryStore } from '../src/main/history';
import type { ChatUpdate } from '../src/shared/chat';

const profile = process.env.TINYGPT_TOOLS_PROFILE!;
mkdirSync(profile, { recursive: true }); app.setPath('userData', profile);
app.setAppPath(resolve(__dirname, '..'));
const history = new HistoryStore(join(profile, 'library.sqlite'));
const chat = history.createConversation(null); history.renameConversation(chat.id, 'Completed scroll fixture');
if (process.env.TINYGPT_SCROLL_PRIOR_TURN) {
  const previous = history.startTurn(chat.id, 'Earlier research', 'local');
  history.saveReply(previous.assistantId, 'Earlier completed answer.', 'complete');
}
let turn: ReturnType<HistoryStore['startTurn']>;
history.selectConversation(chat.id);
const publish = (running: boolean) => {
  const update: ChatUpdate = { conversation: history.conversation(chat.id), library: { projects: history.projects(), conversations: history.conversations(), lastConversationId: chat.id, activeRuns: running ? [{ conversationId: chat.id, runId: turn.runId, phase: 'answer', textLane: 'answer' }] : [], approvals: [], browserHandoffs: [], browserTasks: [] } };
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('tinygpt:chat-update', update);
};
(globalThis as any).completedScrollFixture = {
  begin() {
    turn = history.startTurn(chat.id, 'Research desktop apps and show a detailed comparison.', 'local');
    history.saveReply(turn.assistantId, '', 'streaming'); publish(true);
  },
  answer() { history.saveReply(turn.assistantId, 'Here is the detailed comparison.', 'streaming', null, 'Checking the research.', 85000); publish(true); },
  grow() {
    history.saveReply(turn.assistantId, Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1}. Detailed evidence about desktop capabilities and permissions.`).join('\n\n'), 'streaming', null, 'Checking the research.', 85000); publish(true);
  },
  finish() {
    const tool = randomUUID(); history.addTool(tool, chat.id, turn.runId, 'present', 'Present research comparison');
    history.finishTool(tool, 'success', JSON.stringify({ ui: { $type: 'Col', children: [
      { $type: 'Header', text: 'Desktop research comparison' },
      ...Array.from({ length: 35 }, (_, index) => ({ $type: 'Fact', label: `Research section ${index + 1}`, value: 'A detailed comparison of desktop capabilities, tools, permissions, and supported workflows.' })),
      { $type: 'Header', text: 'Where to go deeper' },
      { $type: 'Text', value: 'Final section of the completed comparison.' },
    ] } }));
    history.saveReply(turn.assistantId, 'Here is the detailed comparison.', 'complete', null, 'Checking the research.', 85000); publish(false);
  },
  late() {
    history.saveReply(turn.assistantId, Array.from({ length: 45 }, (_, index) => `Supplement ${index + 1}. Additional details received with the final saved answer.`).join('\n\n'), 'complete', null, 'Checking the research.', 85000); publish(false);
  },
};
app.on('browser-window-created', (_event, window) => { window.hide(); window.show = () => {}; window.focus = () => {}; });
require('../out/main/index.js');
