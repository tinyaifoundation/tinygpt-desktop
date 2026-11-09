import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryStore } from '../src/main/history';
import { ChatService } from '../src/main/chat-service';
import { defaultSettings } from '../src/shared/config';
import { profileNameSchema } from '../src/shared/memory';
import { friendlyToolLabel } from '../src/shared/tool-labels';

const stores: HistoryStore[] = [];
const store = () => { const history = new HistoryStore(':memory:'); stores.push(history); return history; };
afterEach(() => { for (const history of stores.splice(0)) history.close(); });

describe('profile name memory', () => {
  it('creates one managed memory, updates it on rename, and removes it when the name is cleared', () => {
    const { memory } = store();
    memory.saveProfileName({ firstName: '', lastName: '' });
    memory.saveProfileName({ firstName: 'Personal', lastName: '' });
    expect(memory.memories()).toEqual([]);
    memory.saveProfileName(profileNameSchema.parse({ firstName: ' Ada ', lastName: ' Lovelace ' }));
    const saved = memory.memories()[0];
    expect(saved.text).toBe("The user's name is Ada Lovelace.");
    expect(memory.profileNameMemory()?.id).toBe(saved.id);
    memory.saveProfileName({ firstName: 'Ada', lastName: 'Byron' });
    expect(memory.memories()).toHaveLength(1);
    expect(memory.memories()[0]).toMatchObject({ id: saved.id, text: "The user's name is Ada Byron." });
    memory.saveProfileName({ firstName: '', lastName: '' });
    expect(memory.memories()).toEqual([]);
    expect(memory.profileNameMemory()).toBeUndefined();
  });
  it('respects explicit sharing opt-out, paused records and forgetting', () => {
    const { memory } = store();
    memory.setPreference('personal', false);
    memory.saveProfileName({ firstName: 'Ada', lastName: '' });
    expect(memory.preference('personal')).toBe(false);
    expect(memory.profileNameMemory()).toBeUndefined();
    memory.setPreference('personal', true);
    const saved = memory.memories()[0];
    memory.saveMemory({ ...saved, enabled: false });
    memory.saveProfileName({ firstName: 'Ada', lastName: 'Byron' });
    expect(memory.profileNameMemory()).toBeUndefined();
    memory.saveMemory({ ...memory.memories()[0], enabled: true });
    expect(memory.profileNameMemory()).toBeDefined();
    memory.remove(saved.id);
    expect(memory.profileNameMemory()).toBeUndefined();
  });
  it('includes the name on unrelated turns and across Projects, honoring sharing and read permissions', async () => {
    const history = store();
    history.memory.saveProfileName({ firstName: 'Ada', lastName: 'Lovelace' });
    const chat = history.createConversation(history.createProject('Project', '').id);
    let settings = { ...structuredClone(defaultSettings), local: { ...defaultSettings.local, model: 'fixture' } };
    const inputs: string[] = [];
    const service = new ChatService(history, () => settings, () => undefined, { async run(input, _signal, delta) { inputs.push(input.instructions); delta('Answer'); } }, () => {});
    const turn = async () => { service.start(chat.id, 'Hello'); await vi.waitFor(() => expect(service.isActive(chat.id)).toBe(false)); };
    await turn(); expect(inputs[0]).toContain("The user's name is Ada Lovelace.");
    history.memory.setPreference('personal', false);
    await turn(); expect(inputs[1]).not.toContain("The user's name is");
    history.memory.setPreference('personal', true);
    settings = { ...settings, toolPermissions: { ...settings.toolPermissions, read: 'deny' } };
    await turn(); expect(inputs[2]).not.toContain("The user's name is");
    await service.shutdown();
  });
});

describe('profile tool labels', () => {
  it('uses clear names for native tools and strips internal connector hashes', () => {
    expect(friendlyToolLabel('code_grep')).toBe('Search files');
    expect(friendlyToolLabel('computer_read_window')).toBe('Read desktop windows');
    expect(friendlyToolLabel('ext_read_mail_0123456789abcdef01234567')).toBe('Read mail');
    expect(friendlyToolLabel('ext_0123456789abcdef01234567')).toBe('Plugin tool');
  });
});
