import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { browserTargetPage, browserToolResult } from '../src/core/browser-snapshot';
import { toolArguments } from '../src/shared/tools';
import type { AXNode } from '../src/core/browser-accessibility';
import { accessibilityOutlineDetail, safeBrowserHref } from '../src/core/browser-accessibility';

const recorded = readFileSync(new URL('./fixtures/openrouter-browser-snapshot.json', import.meta.url), 'utf8');
const page = JSON.parse(recorded);
const nodes: AXNode[] = Array.from({ length: 210 }, (_, i) => ({ nodeId: String(i), ignored: false, backendDOMNodeId: i + 1, role: { value: i === 205 ? 'tab' : 'button' }, name: { value: i === 205 ? 'Image' : `Control ${i}` } }));

describe('browser target delivery', () => {
  it('focuses modal descendants before filtering/paging and explicitly permits a page-wide search', () => {
    const modal: AXNode = { nodeId: 'modal', ignored: false, role: { value: 'dialog' }, name: { value: 'Preferences' }, properties: [{ name: 'modal', value: { value: true } }], childIds: ['inside'] };
    const inside: AXNode = { nodeId: 'inside', ignored: false, backendDOMNodeId: 999, role: { value: 'checkbox' }, name: { value: 'Updates' } };
    const all = [...nodes, modal, inside];
    expect(browserTargetPage(all).nodes).toEqual([inside]);
    expect(browserTargetPage(all, { query: 'Control' }).targets).toMatchObject({ matched: 0, total: 211, scope: 'dialog', scopeTotal: 1 });
    expect(browserTargetPage(all, { scope: 'page', query: 'Image' }).nodes).toEqual([nodes[205]]);
    expect(browserTargetPage(all, { query: 'Updates' }).nodes).toEqual([inside]);
  });
  it('reports outline truncation separately from target/text coverage and exposes only web link destinations', () => {
    expect(accessibilityOutlineDetail(nodes, new Map()).coverage.truncated).toBe(false);
    const large = Array.from({ length: 500 }, (_, i) => ({ ...nodes[0], nodeId: String(i) }));
    expect(accessibilityOutlineDetail(large, new Map()).coverage.truncated).toBe(true);
    expect(safeBrowserHref('/settings', 'https://example.org/repo')).toBe('https://example.org/settings');
    for (const href of ['javascript:alert(1)', 'file:///secret', 'https://user:password@example.org']) expect(safeBrowserHref(href, 'https://example.org')).toBeUndefined();
  });
  it('preserves modal, HTTP-error and text-scope evidence with executable saved-reader hints', () => {
    const sourceId = 'f7730717-2255-4746-853a-5abbd513fb6b';
    const value = JSON.parse(browserToolResult(JSON.stringify({ ...page, activeDialog: { title: 'Preferences' }, httpStatus: 401, pageError: 'authentication-required', sourceId, textCoverage: { scope: 'dialog', totalCharacters: 30000, truncated: true } })));
    expect(value).toMatchObject({ activeDialog: { title: 'Preferences' }, httpStatus: 401, pageError: 'authentication-required', textCoverage: { scope: 'dialog', totalCharacters: 30000, truncated: true }, nextRead: { tool: 'read_source', input: { sourceId } } });
  });
  it.each([1024, 2000, 6000, 12000])('preserves OpenRouter targets as valid JSON under a %i character cap', limit => {
    const result = browserToolResult(recorded, limit);
    expect(result.length).toBeLessThanOrEqual(limit);
    const received = JSON.parse(result);
    expect(received.tabId).toBe(page.tabId);
    expect(received.elements.length).toBeGreaterThan(0);
    expect(received.elements).toEqual(page.elements.slice(0, received.elements.length));
    expect(received.targets.nextOffset).toBe(received.elements.length < page.elements.length ? received.elements.length : undefined);
    if (limit >= 6000) expect(received.elements).toContainEqual({ id: 't23', role: 'tab', label: 'Image' });
    expect(received.textCoverage.truncated).toBe(true);
  });
  it('filters the full tree and pages beyond the old 150-target cutoff', () => {
    expect(browserTargetPage(nodes, { query: 'IMAGE', role: 'tab' }).nodes).toEqual([nodes[205]]);
    const pages = [0, 40, 80, 120, 160, 200].flatMap(offset => browserTargetPage(nodes, { offset }).nodes);
    expect(pages).toEqual(nodes);
    expect(browserTargetPage(nodes, { offset: 200 }).targets.nextOffset).toBeUndefined();
    expect(browserTargetPage(nodes, { query: 'absent' }).targets).toMatchObject({ total: 210, matched: 0 });
  });
  it('preserves filter and pagination metadata when fitting the transport budget', () => {
    const selected = { ...page, targets: { offset: 160, limit: 50, total: 210, matched: 210, role: 'button' }, elements: page.elements.slice(0, 50) };
    const result = JSON.parse(browserToolResult(JSON.stringify(selected), 2000));
    expect(result.targets).toMatchObject({ offset: 160, total: 210, role: 'button', nextOffset: 160 + result.elements.length });
    expect(JSON.parse(browserToolResult(JSON.stringify(result), 2000)).textCoverage.totalCharacters).toBe(page.text.length);
  });
  it('keeps stale-action recovery, waits, citations and complete target objects', () => {
    const result = JSON.parse(browserToolResult(JSON.stringify({ error: 'Changed', code: 'BROWSER_TARGET_STALE', snapshot: { ...page, pending: false, wait: { matched: true }, sourceId: 'source', citation: '[Rankings](https://openrouter.ai/rankings)' } })));
    expect(result).toMatchObject({ error: 'Changed', code: 'BROWSER_TARGET_STALE', snapshot: { tabId: page.tabId, pending: false, wait: { matched: true }, sourceId: 'source' } });
    expect(result.snapshot.elements).toContainEqual({ id: 't23', role: 'tab', label: 'Image' });
    expect(browserToolResult('{"closed":true}')).toBe('{"closed":true}');
  });
  it('does not let escaped prose or a huge URL displace targets', () => {
    const input = { ...page, url: 'https://example.com/' + 'x'.repeat(4000), text: '\u0000"\\'.repeat(10000), elements: [{ id: 't205', role: 'tab', label: 'Image', selected: true }] };
    const result = browserToolResult(JSON.stringify(input), 1024);
    expect(result.length).toBeLessThanOrEqual(1024);
    expect(JSON.parse(result).elements).toEqual(input.elements);
  });
  it('validates snapshot filter/pagination arguments', () => {
    expect(toolArguments.browser_snapshot.parse({ tabId: page.tabId, query: 'Image', role: 'tab' })).toMatchObject({ offset: 0, limit: 40 });
    for (const args of [{ limit: 0 }, { limit: 51 }, { offset: -1 }]) expect(toolArguments.browser_snapshot.safeParse({ tabId: page.tabId, ...args }).success).toBe(false);
  });
});
