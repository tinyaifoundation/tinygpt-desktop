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
const other = history.createConversation(null); history.renameConversation(other.id, 'Other fixture');
const otherTurn = history.startTurn(other.id, 'Another chat', 'local');
history.saveReply(otherTurn.assistantId, 'Other fixture answer.', 'complete');
const chat = history.createConversation(null); history.renameConversation(chat.id, 'Conversation UI fixture');
const previous = history.startTurn(chat.id, 'Earlier research', 'local');
history.saveReply(previous.assistantId, 'Earlier answer.', 'complete', null, 'Earlier thinking.', 5300);
const oldTool = randomUUID();
history.addTool(oldTool, chat.id, previous.runId, 'search_sources', 'Searched sources');
history.finishTool(oldTool, 'success', JSON.stringify({ text: 'Earlier evidence.' }));
history.selectConversation(chat.id);
let turn: ReturnType<HistoryStore['startTurn']>;
const prose = 'Checking the saved research notes and comparing the alternatives carefully before assembling an answer. '.repeat(9);
const reasoning = 'Considering the evidence and checking the alternatives.\n'.repeat(35);
const longAnswer = Array.from({ length: 70 }, (_, i) => `Paragraph ${i + 1}. This is a long response used to verify that scrolling stays responsive as the answer grows.`).join('\n\n');
const publish = (activeRuns: ActiveRun[]) => {
  const update: ChatUpdate = { conversation: history.conversation(chat.id), library: { projects: history.projects(), conversations: history.conversations(), lastConversationId: chat.id, activeRuns, approvals: [], browserHandoffs: [], browserTasks: [] } };
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('tinygpt:chat-update', update);
};
(globalThis as any).conversationUIFixture = {
  begin() {
    turn = history.startTurn(chat.id, 'Compare the evidence', 'local');
    history.saveReply(turn.assistantId, '', 'streaming', null, reasoning, 12300);
    const tool = randomUUID(); history.addTool(tool, chat.id, turn.runId, 'search_sources', 'Searching notes');
    history.finishTool(tool, 'success', JSON.stringify({ text: 'Evidence\n'.repeat(100) }));
    publish([{ conversationId: chat.id, runId: turn.runId, phase: 'thinking', textLane: 'progress', prose }]);
  },
  answer() {
    history.saveReply(turn.assistantId, 'The final answer starts here.', 'streaming', null, reasoning, 12300);
    publish([{ conversationId: chat.id, runId: turn.runId, phase: 'answer', textLane: 'answer' }]);
  },
  grow() {
    history.saveReply(turn.assistantId, longAnswer, 'streaming', null, reasoning, 12300);
    publish([{ conversationId: chat.id, runId: turn.runId, phase: 'answer', textLane: 'answer' }]);
  },
  finish() { history.saveReply(turn.assistantId, longAnswer, 'complete', null, reasoning, 12300); publish([]); },
};
app.on('browser-window-created', (_event, window) => { window.hide(); window.show = () => {}; window.focus = () => {}; });
require('../out/main/index.js');
