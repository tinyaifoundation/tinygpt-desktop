import { app, BrowserWindow } from 'electron';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HistoryStore } from '../src/main/history';
import type { ActiveRun, ChatUpdate } from '../src/shared/chat';

const profile = process.env.TINYGPT_TOOLS_PROFILE!;
mkdirSync(profile, { recursive: true }); app.setPath('userData', profile);
app.setAppPath(resolve(__dirname, '..'));
const history = new HistoryStore(join(profile, 'library.sqlite'));
const conversations = new Map(['code', 'chat'].map(mode => {
  const chat = history.createConversation(null, mode as 'chat' | 'code');
  history.renameConversation(chat.id, mode === 'code' ? 'Work chain fixture' : 'Chat chain fixture');
  const turn = history.startTurn(chat.id, 'Earlier question', 'local');
  history.saveReply(turn.assistantId, 'Earlier answer.', 'complete');
  return [mode, chat.id];
}));
let id = conversations.get('chat')!, turn: ReturnType<HistoryStore['startTurn']>, reasoning = '';
const publish = (activeRuns: ActiveRun[]) => {
  const update: ChatUpdate = { conversation: history.conversation(id), library: { projects: history.projects(), conversations: history.conversations(), lastConversationId: id, activeRuns, approvals: [], browserHandoffs: [], browserTasks: [] } };
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('tinygpt:chat-update', update);
};
(globalThis as any).workingChainFixture = {
  begin(mode: string) {
    id = conversations.get(mode)!; reasoning = '';
    history.selectConversation(id); turn = history.startTurn(id, 'Check the working chain', 'local');
    publish([{ conversationId: id, runId: turn.runId, phase: 'connecting' }]); return turn.assistantId;
  },
  thinking() {
    reasoning = 'Considering the evidence before choosing the next step.';
    history.saveReply(turn.assistantId, '', 'streaming', null, reasoning, 1200);
    publish([{ conversationId: id, runId: turn.runId, phase: 'thinking' }]);
  },
  tool() {
    const tool = randomUUID(); history.addTool(tool, id, turn.runId, 'search_sources', 'Searching notes');
    history.finishTool(tool, 'success', JSON.stringify({ text: 'Verified evidence.' }));
    publish([{ conversationId: id, runId: turn.runId, phase: 'tool', textLane: 'progress' }]);
  },
  answer() {
    history.saveReply(turn.assistantId, 'The answer begins here.', 'streaming', null, reasoning, 2400);
    publish([{ conversationId: id, runId: turn.runId, phase: 'answer', textLane: 'answer' }]);
  },
  finish() { history.saveReply(turn.assistantId, 'The answer begins here.', 'complete', null, reasoning, 2400); publish([]); },
};
app.on('browser-window-created', (_event, window) => window.hide());
require('../out/main/index.js');
