import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HistoryStore } from '../src/main/history';
import { defaultSettings } from '../src/shared/config';

const profile = resolve(process.env.TINYGPT_VOICE_PROFILE!);
mkdirSync(profile, { recursive: true }); app.setPath('userData', profile);
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ ...defaultSettings, route: 'byok' }));
const history = new HistoryStore(join(profile, 'library.sqlite'));
const chat = history.createConversation(null);
const turn = history.startTurn(chat.id, 'Find settings fixture', 'byok');
history.saveReply(turn.assistantId, 'Settings search fixture is ready.', 'complete'); history.close();
app.on('browser-window-created', (_event, window) => window.hide());
require('../out/main/index.js');
