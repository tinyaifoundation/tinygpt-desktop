import type { PageSnapshot } from '../shared/tools';
import { activeAXDialog, axName, axRole, interactiveAXNodes, type AXNode } from './browser-accessibility';

export interface BrowserSnapshotOptions { query?: string; role?: string; offset?: number; limit?: number; scope?: 'active' | 'page' }

/** Filter the complete tree before paging, rather than hiding targets after 150. */
export function browserTargetPage(nodes: AXNode[], options: BrowserSnapshotOptions = {}, dialogVisible = false) {
  const all = interactiveAXNodes(nodes);
  const dialog = activeAXDialog(nodes, dialogVisible);
  const scoped = dialog && options.scope !== 'page' ? all.filter(node => dialog.descendants.has(node.nodeId)) : all;
  const query = options.query?.trim().toLowerCase();
  const role = options.role?.trim().toLowerCase();
  const matches = scoped.filter(node => (!query || axName(node).toLowerCase().includes(query)) && (!role || axRole(node).toLowerCase() === role));
  const offset = options.offset ?? 0, limit = options.limit ?? 40;
  const selected = matches.slice(offset, offset + limit);
  return { nodes: selected, dialog, targets: { offset, limit, total: all.length, matched: matches.length, scope: dialog && options.scope !== 'page' ? 'dialog' as const : 'page' as const, scopeTotal: scoped.length,
    ...(options.query ? { query: options.query } : {}), ...(options.role ? { role: options.role } : {}),
    ...(offset + selected.length < matches.length ? { nextOffset: offset + selected.length } : {}) } };
}

/** Model-facing JSON must fit BEFORE the SDK's generic head/tail truncation.
 * Keep IDs and pagination atomic; page prose and duplicate AX text are expendable.
 * The full observation is retained by the broker/history, independently. */
export function browserToolResult(result: string, maxChars = 6000): string {
  let value: any;
  try { value = JSON.parse(result); } catch { return result; }
  if (value?.snapshot?.tabId && Array.isArray(value.snapshot.elements)) {
    const overhead = JSON.stringify({ ...value, snapshot: null }).length - 4;
    const snapshot = JSON.parse(browserToolResult(JSON.stringify(value.snapshot), maxChars - overhead));
    return JSON.stringify({ ...value, snapshot });
  }
  if (!value?.tabId || !Array.isArray(value.elements)) return result;
  const original = value as PageSnapshot;
  const elements = [...original.elements];
  const targets = { offset: 0, limit: elements.length, total: elements.length, matched: elements.length, ...original.targets };
  const output: Record<string, any> = { tabId: original.tabId, elements, targets,
    snapshotKind: original.snapshotKind, url: original.url, title: original.title, challenge: original.challenge };
  for (const key of ['error', 'code', 'retryable', 'actionDispatched', 'pending', 'wait', 'navigation', 'scroll', 'sourceId', 'citation', 'observationId', 'capturedAt', 'activeDialog', 'httpStatus', 'pageError', 'accessibilityCoverage']) {
    if (value[key] !== undefined) output[key] = value[key];
  }
  const text = original.text ?? '';
  const totalCharacters = value.textCoverage?.totalCharacters ?? text.length;
  output.text = '';
  output.textCoverage = { ...value.textCoverage, totalCharacters, returnedCharacters: 0, truncated: totalCharacters > 0 };
  output.notice = 'Use elements[].id for actions. Filters search the collected scope before paging. Default scope is the open modal dialog; scope:page includes background controls, which may be blocked. Follow targets.nextOffset with the same filters/scope. Text coverage describes only the named text scope, not the whole DOM.';
  if (value.observationId) output.nextRead = { tool: 'read_observation', input: { id: value.observationId, offset: 0, limit: 4000 } };
  else if (value.sourceId) output.nextRead = { tool: 'read_source', input: { sourceId: value.sourceId, offset: 0, limit: 4000 } };
  if (value.observationId) output.notice += ' read_observation retrieves the full saved result without refetching.';
  // Leave room for useful page text, but never split an element object or ID.
  while (elements.length > 1 && JSON.stringify(output).length > maxChars - 600) elements.pop();
  for (const element of elements) {
    if (JSON.stringify(output).length <= maxChars - 600) break;
    if (element.href) { delete element.href; output.linkDestinationsOmitted = true; }
  }
  if (elements.length < original.elements.length) targets.nextOffset = targets.offset + elements.length;
  // Very long URLs or wait evidence must never crowd out the first target.
  for (const key of ['citation', 'title', 'url', 'navigation', 'scroll', 'notice', 'nextRead']) {
    if (JSON.stringify(output).length <= maxChars - 64) break;
    delete output[key]; output.metadataOmitted = true;
  }
  if (JSON.stringify(output).length > maxChars - 64 && output.wait) {
    const { matched, timedOut, polls, observationComplete, transitionObserved } = output.wait;
    output.wait = { matched, timedOut, polls, observationComplete, transitionObserved };
    output.metadataOmitted = true;
  }
  let low = 0, high = Math.min(2400, text.length);
  const excerpt = (size: number) => {
    output.text = text.slice(0, size);
    output.textCoverage.returnedCharacters = size;
    output.textCoverage.truncated = value.textCoverage?.truncated === true || size < totalCharacters;
  };
  while (low < high) {
    const mid = Math.ceil((low + high) / 2); excerpt(mid);
    if (JSON.stringify(output).length <= maxChars) low = mid; else high = mid - 1;
  }
  excerpt(low);
  return JSON.stringify(output);
}
