import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { randomUUID } from 'node:crypto';
import { chatUICatalog, chatUIComponents, validateChatUI, presentArguments, presentParameters, restoreSavedChatUI, CHAT_OUTPUT_INSTRUCTIONS } from '../src/shared/generative-ui';
import { restoreSavedChatUI as restoreLegacy } from '../src/shared/legacy-generative-ui';
import { generativeParts } from '../src/core/generative-parts';
import { toolDefinitions } from '../src/shared/tools';
import { agentTools } from '../src/core/agent-tools';
import { HistoryStore } from '../src/main/history';
import { ToolBroker } from '../src/main/tool-broker';
import { ChatService } from '../src/main/chat-service';
import { defaultSettings } from '../src/shared/config';
import type { BrowserController } from '../src/main/browser';
import type { ProjectFiles } from '../src/main/files';
const spec = (type: string, props: Record<string, unknown>, children: string[] = []) => ({ root: 'main', elements: { main: { type, props, children } } });
const tree = spec('Comparison', { title: 'Budget', columns: [{ label: 'Item' }, { label: 'Cost' }], rows: [['Hosting', 20], ['Design', 100]], sortable: true });

describe('json-render Chat output contract', () => {
  it('derives provider schemas, validation and the renderer vocabulary from one catalog', () => {
    const accepts = new Ajv({ strict: false }).compile(presentParameters);
    for (const sample of [tree, spec('MetricGrid', { metrics: [{ label: 'Total', value: '$120' }] }), spec('ChartPanel', { title: 'Costs', variant: 'bar', data: [{ label: 'Hosting', value: 20 }] }), spec('Checklist', { title: 'Plan', items: [{ text: 'Ship calculator' }] }), spec('Timeline', { title: 'Launch', items: [{ title: 'Release', date: 'Friday' }] })]) {
      expect(accepts(sample), JSON.stringify(accepts.errors)).toBe(true);
      expect(chatUICatalog.validate(sample).success).toBe(true);
      expect(validateChatUI(sample)).toEqual(sample);
    }
    expect(chatUICatalog.componentNames.sort()).toEqual(Object.keys(chatUIComponents).sort());
    expect(toolDefinitions.find(tool => tool.name === 'present')?.schema.properties.elements).toEqual(presentParameters.properties.elements);
    expect(presentArguments.safeParse({ $type: 'Text', value: 'Obsolete tool arguments' }).success).toBe(false);
  });
  it('advertises proactive visual guidance and calculator access across modes', () => {
    expect(CHAT_OUTPUT_INSTRUCTIONS).toContain('The user need not ask for a visual');
    for (const mode of ['chat', 'code', 'bot'] as const) expect(agentTools({ mode }).map(tool => tool.name)).toContain('calculate');
    expect(agentTools({ mode: 'chat' }).map(tool => tool.name)).toContain('present');
    expect(agentTools({ mode: 'code' }).map(tool => tool.name)).not.toContain('present');
  });
  it('rejects actions, expressions, unknown props/components and unsafe element graphs', () => {
    const bad = [spec('iframe', { src: 'https://example.com' }), spec('Text', { value: 'Safe', onClick: 'run' }), spec('Text', { value: { $state: '/secret' } }), { ...tree, state: {} }, { ...tree, elements: { main: { type: 'Text', props: { value: 'Safe' }, children: [], on: { click: { action: 'execute' } } } } }, spec('Card', {}, ['missing']), spec('Card', {}, ['main']), { root: 'main', elements: { main: { type: 'Card', props: {}, children: ['child', 'child'] }, child: { type: 'Text', props: { value: 'x' }, children: [] } } }];
    for (const input of bad) expect(presentArguments.safeParse(input).success, JSON.stringify(input)).toBe(false);
    expect(() => validateChatUI(spec('Text', { value: 'x'.repeat(80001) }))).toThrow('too large');
    expect(() => validateChatUI(spec('Table', { columns: [{ label: 'Name' }], rows: [['A', 'extra']] }))).toThrow('exactly 1 cells');
    expect(() => validateChatUI(spec('ChartPanel', { title: 'Trend', variant: 'line', data: [{ label: 'Jan', value: 1 }] }))).toThrow('2–60');
    expect(() => validateChatUI(spec('ChartPanel', { title: 'Trend', variant: 'bar', data: [{ value: 1 }] }))).toThrow('Label every point');
    expect(() => validateChatUI(spec('Text', { value: 'x' }, ['main']))).toThrow('does not accept children');
  });
  it('bounds graph depth, size, detached content and mismatched chart categories', () => {
    const elements: Record<string, any> = {};
    for (let index = 0; index < 15; index++) elements[index] = { type: 'Card', props: {}, children: index < 14 ? [String(index + 1)] : [] };
    expect(() => validateChatUI({ root: '0', elements })).toThrow('nesting');
    expect(() => validateChatUI({ ...tree, elements: { ...tree.elements, detached: { type: 'Text', props: { value: 'Hidden' }, children: [] } } })).toThrow();
    expect(() => validateChatUI(spec('ChartPanel', { title: 'Trend', variant: 'line', series: [{ label: 'A', data: [{ label: 'Jan', value: 1 }, { label: 'Feb', value: 2 }] }, { label: 'B', data: [{ label: 'Mar', value: 3 }, { label: 'Apr', value: 4 }] }] }))).toThrow('Match point labels');
  });
  it('restores historic Assistant UI trees and malformed encoded children without changing saved data', () => {
    const legacy = { $type: 'Card', title: 'Saved budget', children: [{ $type: 'Fact', label: 'Total', value: '$120' }, { $type: 'Text', value: 'Hello' }] };
    const before = JSON.stringify(legacy);
    const restored = restoreSavedChatUI(legacy);
    expect(chatUICatalog.validate(restored.ui).success).toBe(true);
    expect(Object.values(restored.ui.elements).map(element => element.type)).toEqual(expect.arrayContaining(['Card', 'MetricGrid', 'Text']));
    expect(JSON.stringify(legacy)).toBe(before);
    const malformed = { $type: 'Card', children: '[{"$type":"Text","value":"Recovered"}, broken' };
    expect(restoreLegacy(malformed).partial).toBe(true);
    expect(restoreSavedChatUI(malformed).partial).toBe(true);
    expect(() => restoreSavedChatUI({ $type: 'Text', value: 'Unsafe', onClick: 'run' })).toThrow();
  });
  it('persists and replays validated outputs without file permissions, preserving large content', async () => {
    const history = new HistoryStore(':memory:');
    try {
      const conversation = history.createConversation(null); const turn = history.startTurn(conversation.id, 'Show a budget', 'local');
      const settings = { ...defaultSettings, toolPermissions: Object.fromEntries(Object.keys(defaultSettings.toolPermissions).map(key => [key, 'deny'])) } as typeof defaultSettings;
      const broker = new ToolBroker(history, () => settings, {} as BrowserController, {} as ProjectFiles, () => {});
      const context = { conversationId: conversation.id, runId: turn.runId, signal: new AbortController().signal };
      for (const ui of [tree, spec('Text', { value: 'Full report. '.repeat(5000) })]) {
        const id = randomUUID();
        expect(JSON.parse(await broker.execute(context, { id, name: 'present', input: ui }))).toEqual({ presented: true });
        const saved = history.conversation(conversation.id).tools.find(tool => tool.id === id)!;
        expect(saved.status).toBe('success'); expect(JSON.parse(saved.result!).ui).toEqual(ui);
        expect(generativeParts([saved])[0]).toMatchObject({ toolName: 'present', args: ui, result: { presented: true } });
      }
      expect(broker.approvals()).toEqual([]);
      const failure = JSON.parse(await broker.execute(context, { id: randomUUID(), name: 'present', input: spec('MetricGrid', { metrics: [{ label: 'Missing value' }] }) }));
      expect(failure.error).toContain('elements.main.props (MetricGrid)'); expect(failure.error).toContain('value');
    } finally { history.close(); }
  });
  it('keeps interfaces out of Work while allowing a managed workspace', async () => {
    const history = new HistoryStore(':memory:');
    try {
      const conversation = history.createConversation(null, 'code');
      const settings = { ...defaultSettings, mode: 'code' as const, local: { ...defaultSettings.local, model: 'fixture', tools: true } };
      const broker = new ToolBroker(history, () => settings, {} as BrowserController, {} as ProjectFiles, () => {});
      expect(JSON.parse(await broker.execute({ conversationId: conversation.id, runId: randomUUID(), signal: new AbortController().signal }, { id: randomUUID(), name: 'present', input: tree })).error).toContain('Chat');
      const chat = new ChatService(history, () => settings, () => '', { async run(_input, _signal, delta) { delta('No verified outcome'); } }, () => {});
      chat.start(conversation.id, 'Build it');
      await chat.shutdown();
      expect(history.conversation(conversation.id).messages).toHaveLength(2);
    } finally { history.close(); }
  });
});
