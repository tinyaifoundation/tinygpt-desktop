import { expect, it } from 'vitest';
import { StableWorkTools, invokeWorkTool } from '../src/core/stable-work-tools';
import { toolDefinitions } from '../src/shared/tools';
import { withoutToolMetadata } from '../src/core/work-tool-catalog';

const plugin = { name: 'ext_fixture_search', description: 'Search the selected account.', schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } };
const count = (text: string) => Math.ceil(Buffer.byteLength(text) / 3);
const create = (budget = 10000) => new StableWorkTools([...toolDefinitions.map(withoutToolMetadata), plugin], budget, count);

it('keeps exact wire definitions stable across browser, plugin, image and desktop discovery', () => {
  const surface = create(), wire = JSON.stringify([...surface.direct, invokeWorkTool]);
  expect(surface.direct.map(tool => tool.name)).toContain('browser_click');
  expect(surface.direct.map(tool => tool.name)).toContain('view_image');
  expect(wire).not.toContain(plugin.description);
  surface.discover('browser', 'browser_snapshot');
  const result = surface.serviceResult({ enabled: 'services', toolNames: [plugin.name], availableActionCount: 1 });
  expect(result).toMatchObject({ toolNames: [], actions: [{ name: plugin.name, parameters: plugin.schema, invokeWith: 'invoke_tool' }], availableActionCount: 1 });
  surface.discover('images', 'generate_image'); surface.discover('desktop', 'computer_click');
  surface.serviceResult({ enabled: 'services', toolNames: [] });
  expect(JSON.stringify([...surface.direct, invokeWorkTool])).toBe(wire);
  expect(surface.resolve({ name: plugin.name, input: { query: 'test' } })).toBe(plugin);
});

it('rejects undiscovered actions, uncaptured plugins, dispatcher recursion and malformed inputs', () => {
  const surface = create();
  for (const name of [plugin.name, 'ext_other_account', 'invoke_tool', 'load_tools', 'powershell']) expect(() => surface.resolve({ name, input: {} })).toThrow();
  expect(() => surface.serviceResult({ enabled: 'services', toolNames: ['ext_other_account'] })).toThrow('captured');
  expect(() => surface.resolve({ name: 'browser_click', input: [] })).toThrow();
  expect(() => surface.resolve({ name: 'browser_click', input: { text: 'x'.repeat(120001) } })).toThrow();
});

it('keeps oversized discovery bounded and preserves previous loads on failed discovery', () => {
  const huge = { name: 'ext_huge', description: 'z'.repeat(10000), schema: {} };
  const surface = new StableWorkTools([plugin, huge], 600, count);
  surface.serviceResult({ enabled: 'services', toolNames: [plugin.name] });
  expect(() => surface.serviceResult({ enabled: 'services', toolNames: [huge.name] })).toThrow('TOOL_SELECTION_REQUIRED');
  expect(surface.resolve({ name: plugin.name, input: {} })).toBe(plugin);
  expect(() => surface.resolve({ name: huge.name, input: {} })).toThrow();
});

it('selects a bounded initial browser set once and discovers omitted actions without changing it', () => {
  const surface = create(2000), before = JSON.stringify(surface.direct);
  const omitted = toolDefinitions.find(tool => tool.name.startsWith('browser_') && !surface.direct.some(direct => direct.name === tool.name))!;
  expect(omitted).toBeDefined();
  expect(surface.discover('browser', omitted.name).actions).toContainEqual(expect.objectContaining({ name: omitted.name, invokeWith: 'invoke_tool' }));
  expect(surface.resolve({ name: omitted.name, input: {} }).name).toBe(omitted.name);
  expect(JSON.stringify(surface.direct)).toBe(before);
});
