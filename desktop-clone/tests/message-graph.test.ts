import { expect, it } from 'vitest';
import { visibleMessageGraph } from '../src/renderer/lib/message-graph';

it('collapses hidden steering parents and preserves subsequent turns by ID', () => {
  // A steer can be inserted after the assistant row and become its saved parent.
  const saved = [
    { id: 'request', parentId: null }, { id: 'reply', parentId: 'steer' },
    { id: 'steer', parentId: 'request' }, { id: 'followup', parentId: 'reply' },
    { id: 'continued', parentId: 'followup' },
  ];
  const before = JSON.stringify(saved);
  const graph = visibleMessageGraph(saved, ['request', 'reply', 'followup', 'continued'], 'continued');
  expect([...graph.parents]).toEqual([['request', null], ['reply', 'request'], ['followup', 'reply'], ['continued', 'followup']]);
  expect(graph.headId).toBe('continued'); expect(JSON.stringify(saved)).toBe(before);
});
it('keeps regeneration branches and resolves a hidden selected head', () => {
  const saved = [{ id: 'u', parentId: null }, { id: 'a', parentId: 'u' }, { id: 'b', parentId: 'u' }, { id: 'hidden', parentId: 'a' }];
  const graph = visibleMessageGraph(saved, ['u', 'a', 'b'], 'hidden');
  expect(graph.headId).toBe('a'); expect(graph.parents.get('b')).toBe('u');
});
it('supports legacy sequential messages and safely ends missing or cyclic hidden ancestry', () => {
  const legacy = visibleMessageGraph([{ id: 'u' }, { id: 'a' }], ['u', 'a'], 'a');
  expect(legacy.parents.get('a')).toBe('u');
  const graph = visibleMessageGraph([{ id: 'a', parentId: 'hidden' }, { id: 'hidden', parentId: 'a' }], ['a'], 'missing');
  expect(graph.parents.get('a')).toBe(null); expect(graph.headId).toBe(null);
});
