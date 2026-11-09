import type { ChatMessage, ContextActivity, WorkActivity } from '../shared/chat';
import type { ToolActivity } from '../shared/tools';
import { isComputerTool } from '../shared/computer';

export const WORK_DISPLAY_CHARACTER_LIMIT = 500000;
export const workDisplayTail = (text: string) => text.slice(-WORK_DISPLAY_CHARACTER_LIMIT);

/** Observes saved part snapshots, so SSE replay and final reconciliation are
 * idempotent. Recording has no effect on execution or tool permissions. */
export class WorkActivityRecorder {
  private entries: WorkActivity[];
  constructor(private runId: string, initial: readonly WorkActivity[] = []) { this.entries = initial.map(entry => ({ ...entry })); this.trimDisplay(); }
  part(id: string, kind: 'prose' | 'reasoning', text: string, startedAt?: number, answer?: boolean, omittedCharacters = 0, agentId?: string) {
    const key = `${this.runId}:${id}`;
    const existing = this.entries.find(entry => entry.id === key);
    if (existing) {
      const start = existing.omittedCharacters ?? 0, end = start + existing.text.length;
      const overlap = Math.max(start, omittedCharacters);
      if (omittedCharacters + text.length >= end && (overlap >= end || text.slice(overlap - omittedCharacters, end - omittedCharacters) === existing.text.slice(overlap - start))) {
        existing.text = text.slice(Math.max(start, omittedCharacters) - omittedCharacters);
        existing.omittedCharacters = Math.max(start, omittedCharacters) || undefined;
      }
      if (agentId !== undefined) existing.agentId = agentId;
      if (startedAt !== undefined) existing.startedAt = startedAt; if (answer !== undefined) existing.answer = answer;
    } else this.entries.push({ id: key, runId: this.runId, kind, text, ...(agentId ? { agentId } : {}), startedAt: startedAt ?? Date.now(), ...(answer !== undefined ? { answer } : {}), ...(omittedCharacters ? { omittedCharacters } : {}) });
    this.order(); this.trimDisplay();
  }
  private trimDisplay() {
    let remaining = WORK_DISPLAY_CHARACTER_LIMIT;
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index];
      if (entry.kind !== 'prose' && entry.kind !== 'reasoning') continue;
      const removed = Math.max(0, entry.text.length - remaining);
      if (removed) { entry.text = entry.text.slice(removed); entry.omittedCharacters = (entry.omittedCharacters ?? 0) + removed; }
      remaining -= entry.text.length;
    }
  }
  tool(id: string, agentId?: string) {
    const key = `${this.runId}:tool:${id}`;
    const existing = this.entries.find(entry => entry.id === key);
    if (existing) { if (agentId !== undefined) existing.agentId = agentId; }
    else this.entries.push({ id: key, runId: this.runId, kind: 'tool', toolId: id, ...(agentId ? { agentId } : {}), text: '', startedAt: Date.now() });
    this.order();
  }
  steer(messageId: string, text: string) {
    const id = `${this.runId}:steering:${messageId}`;
    if (!this.entries.some(entry => entry.id === id)) this.entries.push({ id, runId: this.runId, kind: 'steering', messageId, text, startedAt: Date.now() });
    this.order();
  }
  private order() {
    // Native generation times survive late/replayed SSE text. Tool hooks mark
    // their actual start, rather than the later arrival of their saved result.
    // Previous runs keep their original order through a continuation.
    this.entries.sort((a, b) => a.runId === this.runId && b.runId === this.runId ? (a.startedAt ?? 0) - (b.startedAt ?? 0) : 0);
  }
  complete(answerPartIds: readonly string[]) {
    const ids = new Set(answerPartIds.map(id => `${this.runId}:${id}`));
    for (const entry of this.entries) if (entry.runId === this.runId && entry.kind === 'prose') entry.answer = !entry.agentId && ids.has(entry.id);
    return this.entries.filter(entry => entry.runId === this.runId && entry.answer).map(entry => entry.text).join('\n\n');
  }
  snapshot() { return this.entries.map(entry => ({ ...entry })); }
}

export type WorkStep = { id: string; kind: 'reasoning'; text: string } | { id: string; kind: 'tool'; tool: ToolActivity };
export type WorkBlock = { id: string; kind: 'prose'; text: string } | { id: string; kind: 'steering'; text: string } | { id: string; kind: 'context'; activity: ContextActivity } | { id: string; kind: 'tools'; tools: ToolActivity[]; steps: WorkStep[] } | { id: string; kind: 'agent'; tool: ToolActivity; blocks: WorkBlock[] };
/** Steering stays in model history, but is shown only inside its active Work turn. */
export function workSteeringMessageIds(messages: readonly ChatMessage[]) {
  return new Set(messages.flatMap(message => message.workActivity?.flatMap(entry => entry.kind === 'steering' && entry.messageId ? [entry.messageId] : []) ?? []));
}
function toolCategory(tool: ToolActivity) {
  if (isComputerTool(tool.name)) return 'desktop';
  if (tool.name !== 'browser_screenshot' && /image|screenshot/.test(tool.name)) return 'images';
  if (/bash|command/.test(tool.name)) return 'commands';
  if (/search_sources|search_web|read_page|web_page|browser|code_devtools/.test(tool.name)) return 'web';
  if (/read|glob|grep|list_project/.test(tool.name)) return 'files';
  if (/write|edit|patch|directory/.test(tool.name)) return 'edits';
  return 'other';
}
export function workBlocks(activity: readonly WorkActivity[], tools: readonly ToolActivity[], contexts: readonly ContextActivity[] = [], activeRunId?: string): WorkBlock[] {
  const blocks: WorkBlock[] = [];
  const byId = new Map(tools.map(tool => [tool.id, tool]));
  const seen = new Set<string>();
  const agents = new Map<string, Extract<WorkBlock, { kind: 'agent' }>>();
  const owners = new Map(activity.filter(entry => entry.toolId && entry.agentId).map(entry => [entry.toolId!, entry.agentId!]));
  const agent = (id: string) => {
    const tool = byId.get(id);
    if (tool?.name !== 'code_delegate') return undefined;
    let block = agents.get(id);
    if (!block) { block = { id: `agent:${id}`, kind: 'agent', tool, blocks: [] }; agents.set(id, block); blocks.push(block); }
    return block;
  };
  const destination = (agentId?: string) => agentId ? agent(agentId)?.blocks ?? blocks : blocks;
  const appendStep = (step: WorkStep, agentId?: string) => {
    const target = destination(agentId);
    let last = target.at(-1);
    // Prose stays between its actual toolchains within the same agent.
    if (last?.kind !== 'tools') { last = { id: `chain:${step.id}`, kind: 'tools', tools: [], steps: [] }; target.push(last); }
    last.steps.push(step);
    if (step.kind === 'tool') last.tools.push(step.tool);
  };
  const appendTool = (tool: ToolActivity) => {
    if (seen.has(tool.id)) return;
    seen.add(tool.id);
    if (tool.name === 'code_delegate') { agent(tool.id); return; }
    appendStep({ id: tool.id, kind: 'tool', tool }, owners.get(tool.id));
  };
  const timeline: { at: number; entry?: WorkActivity; context?: ContextActivity }[] = [
    ...activity.map(entry => ({ at: entry.startedAt ?? byId.get(entry.toolId ?? '')?.createdAt ?? 0, entry })),
    ...contexts.map(context => ({ at: context.createdAt, context })),
  ];
  const seenContexts = new Set<string>();
  let omissionShown = false;
  for (const item of timeline.sort((a, b) => a.at - b.at)) {
    if (item.context) {
      if (!seenContexts.has(item.context.id)) { seenContexts.add(item.context.id); blocks.push({ id: `context:${item.context.id}`, kind: 'context', activity: item.context }); }
      continue;
    }
    const entry = item.entry!;
    if (entry.answer && !entry.agentId) continue;
    if (entry.omittedCharacters && !omissionShown) {
      omissionShown = true;
      destination(entry.agentId).push({ id: 'work-display-omitted', kind: 'prose', text: 'Earlier working notes are omitted from this view. Full details are saved.' });
    }
    if (entry.kind === 'tool') { const tool = byId.get(entry.toolId ?? ''); if (tool) appendTool(tool); }
    else if (entry.kind === 'steering') { if (entry.runId === activeRunId) blocks.push({ id: entry.id, kind: 'steering', text: entry.text }); }
    else if (entry.text.trim()) {
      if (entry.kind === 'reasoning') appendStep({ id: entry.id, kind: 'reasoning', text: entry.text }, entry.agentId);
      else destination(entry.agentId).push({ id: entry.id, kind: 'prose', text: entry.text });
    }
  }
  // Older conversations and a tool's first publication can lack activity
  // records. Preserve their real tools without inventing historical prose.
  for (const tool of tools) appendTool(tool);
  return blocks;
}
export function workToolSummary(tools: readonly ToolActivity[]) {
  const categories = new Set(tools.map(toolCategory));
  const labels: string[] = [];
  if (categories.has('desktop')) labels.push('Used desktop tools');
  if (categories.has('commands')) labels.push('Ran commands');
  if (categories.has('web')) labels.push(tools.some(tool => tool.name.startsWith('browser_') || tool.name === 'code_devtools') ? 'Used the browser' : 'Searched the web');
  const images = tools.filter(tool => toolCategory(tool) === 'images').length;
  const files = tools.filter(tool => toolCategory(tool) === 'files').length;
  if (images) labels.push(`Viewed ${images} ${images === 1 ? 'image' : 'images'}`);
  if (files) labels.push(`Inspected ${files} ${files === 1 ? 'file or folder' : 'files or folders'}`);
  if (categories.has('edits')) labels.push('Updated files');
  if (categories.has('other')) labels.push('Used tools');
  return labels.map((label, index) => index ? label.charAt(0).toLowerCase() + label.slice(1) : label).join(', ');
}
