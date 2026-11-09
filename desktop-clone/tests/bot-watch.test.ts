import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { ScheduledStore } from '../src/main/scheduled-store';
import { saveBotWatch, removeBotWatch } from '../src/main/bot-watch';
import { randomUUID } from 'node:crypto';
import { assistantToolAllowed, assistantBrowserAccess } from '../src/core/assistant-tools';

it('keeps identical watches on schedule, preserves a user pause, and protects the general check-in', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tinygpt-bot-watch-'));
  const store = new ScheduledStore(join(directory, 'scheduled.sqlite'));
  try {
    const input = { title: 'Project news', prompt: 'Check meaningful project announcements.', minutes: 60 };
    const saved = saveBotWatch(store, input), before = store.get(saved.id);
    expect(saveBotWatch(store, input)).toMatchObject({ ...saved, unchanged: true });
    expect(store.get(saved.id)).toEqual(before);
    expect(saveBotWatch(store, { ...input, title:'PROJECT NEWS' })).toMatchObject({id:saved.id,unchanged:true});
    expect(saveBotWatch(store, { ...input, title:'Follow project releases' })).toMatchObject({id:saved.id,unchanged:true});
    expect(store.jobs('bot')).toHaveLength(1);
    expect(store.get(saved.id)).toEqual(before);
    store.enabled(saved.id, false);
    expect(saveBotWatch(store, { ...input, id: saved.id })).toMatchObject({ unchanged: true, watching: false, nextRunAt: null });
    expect(saveBotWatch(store, { ...input, id: saved.id, prompt: 'Check official releases.' }).watching).toBe(false);
    expect(saveBotWatch(store, { ...input, title:'New label',prompt:'Check official releases.' })).toMatchObject({id:saved.id,unchanged:true,watching:false});
    expect(() => saveBotWatch(store, { ...input, title: 'Personal check-in' })).toThrow('Check in periodically');
    const user = store.save({ title: input.title, prompt: input.prompt, schedule: { repeat: 'daily', time: '09:00', timezone: 'UTC', weekday: 1, minutes: 60 }, enabled: true, newChat: false, mode: 'chat' });
    expect(() => saveBotWatch(store, { ...input, id: user.id })).toThrow('another feature');
    expect(() => saveBotWatch(store, { ...input, minutes: 5 })).toThrow();
    const upper=saveBotWatch(store,{title:'Upper case path',prompt:'Check https://example.test/A',minutes:60});
    const lower=saveBotWatch(store,{title:'Lower case path',prompt:'Check https://example.test/a',minutes:60});
    expect(upper.id).not.toBe(lower.id);
  } finally {
    store.close(); const target = resolve(directory);
    if (dirname(target).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(target).startsWith('tinygpt-bot-watch-')) throw Error('Unexpected fixture path');
    await rm(target, { recursive: true, force: true });
  }
});

it('does not advertise Work-only actions but retains interactive browser and project files', () => {
  for (const name of ['write_file', 'run_command', 'list_files', 'run_project_command', 'edit_project_file', 'command_stop', 'present']) expect(assistantToolAllowed(name)).toBe(false);
  for (const name of ['browser_tabs', 'browser_click', 'browser_type', 'browser_scroll', 'browser_press_key', 'write_project_file', 'read_project_file', 'load_tools']) expect(assistantToolAllowed(name)).toBe(true);
});

it('removes Bot interest watches durably, handles retries, and protects Scheduled tasks and the general check-in', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tinygpt-bot-watch-'));
  const path = join(directory, 'scheduled.sqlite'); let store = new ScheduledStore(path);
  try {
    const first = saveBotWatch(store, { title: 'Verify deployment', prompt: 'Verify the requested deployment once it is healthy.', minutes: 30 });
    const second = saveBotWatch(store, { title: 'Check email gap', prompt: 'Verify the notification gap.', minutes: 30 });
    store.enabled(first.id, false);
    const base = { title: 'User task', prompt: 'My recurring task', enabled: true, newChat: false, mode: 'chat' as const, schedule: { repeat: 'interval' as const, minutes: 60, time: '09:00', timezone: 'UTC', weekday: 1 } };
    const user = store.save(base), checkIn = store.save({ ...base, title: 'Personal check-in' }, 'bot');
    expect(() => removeBotWatch(store, { id: user.id })).toThrow('another feature');
    expect(() => removeBotWatch(store, { id: checkIn.id })).toThrow('Check in periodically');
    expect(() => removeBotWatch(store, { id: second.id }, first.id)).toThrow('own watch');
    expect(() => removeBotWatch(store, { id: first.id, title: 'Unexpected' })).toThrow();
    expect(removeBotWatch(store, { id: first.id })).toMatchObject({ id: first.id, removed: true, watching: false });
    expect(removeBotWatch(store, { id: first.id })).toMatchObject({ removed: false, unchanged: true });
    expect(removeBotWatch(store, { id: randomUUID() })).toMatchObject({ removed: false, unchanged: true });
    expect(removeBotWatch(store, { id: second.id }, second.id)).toMatchObject({ removed: true });
    store.close(); store = new ScheduledStore(path);
    expect(store.jobs().map(job => job.id).sort()).toEqual([user.id, checkIn.id].sort());
    expect(() => store.claim(first.id, Date.now() + 86400000)).toThrow('no longer exists');
  } finally {
    store.close(); const target = resolve(directory);
    if (dirname(target).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(target).startsWith('tinygpt-bot-watch-')) throw Error('Unexpected fixture path');
    await rm(target, { recursive: true, force: true });
  }
});

it('grounds browser discovery in this turn instead of treating a watch restriction as missing tools',()=>{
  const names=['browser_tabs','browser_open','browser_snapshot','browser_click','browser_type','browser_scroll','browser_hover','browser_press_key','browser_screenshot','view_image'];
  const foreground=assistantBrowserAccess(names.map(name=>({name})),false);
  expect(foreground.interactive).toBe(true);expect(foreground.tools).toEqual(names);
  const background=assistantBrowserAccess(names.filter(name=>!['browser_click','browser_type','browser_scroll','browser_hover','browser_press_key'].includes(name)).map(name=>({name})),true);
  expect(background.interactive).toBe(false);expect(background.mode).toBe('proactive-read-only');
  expect(background.notice).toContain('not missing from the app');
  expect(assistantBrowserAccess([{name:'view_image'}],false).notice).toContain('Browser access is off');
});
