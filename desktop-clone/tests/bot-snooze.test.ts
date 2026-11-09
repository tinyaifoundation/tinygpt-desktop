import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { BotService } from '../src/main/bot-service';
import { HistoryStore } from '../src/main/history';
import { ScheduledStore } from '../src/main/scheduled-store';
import { defaultSettings } from '../src/shared/config';
import { defaultBotConfiguration } from '../src/shared/bot';
import { botAvatarPresentation } from '../src/renderer/lib/bot-avatar';

it('persists sleep, holds deliveries and preserves watch choices until explicit wake', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tinygpt-bot-snooze-'));
  const history = new HistoryStore(':memory:'), schedules = new ScheduledStore(':memory:');
  const make = () => { const bot = new BotService(directory, history, () => defaultSettings, () => {}, async () => {}); bot.schedules = schedules; return bot; };
  const bot = make();
  try {
    const conversation = await bot.complete({ name: 'Milo', projectId: null, configuration: { ...defaultBotConfiguration, background: true, heartbeat: '1h' } });
    const job = schedules.jobs('bot')[0]; schedules.enabled(job.id, false);
    const before = schedules.get(job.id);
    await bot.setSnoozed(true);
    expect(bot.snapshot().snoozed).toBe(true);
    expect(bot.isAwake(new Date(2026, 10, 6, 10).getTime())).toBe(false);
    bot.deliver('A useful finding held during sleep.', 'held-finding');
    expect(history.conversation(conversation.id).messages).toHaveLength(0);
    const reloaded = make(); await reloaded.load();
    expect(reloaded.isSnoozed()).toBe(true);
    expect(reloaded.snapshot().configuration).toEqual(bot.snapshot().configuration);
    await reloaded.setSnoozed(false); reloaded.flushDeliveries();
    expect(reloaded.isSnoozed()).toBe(false);
    expect(history.conversation(conversation.id).messages.at(-1)?.text).toContain('useful finding');
    expect(schedules.get(job.id)).toEqual(before);
    expect(botAvatarPresentation('snooze', 'happy')).toEqual({ expression: 'sleepy', animation: 'snooze.4' });
    await reloaded.shutdown();
  } finally {
    await bot.shutdown(); schedules.close(); history.close();
    const target = resolve(directory);
    if (dirname(target).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(target).startsWith('tinygpt-bot-snooze-')) throw Error('Unexpected fixture path');
    await rm(target, { recursive: true, force: true });
  }
});
