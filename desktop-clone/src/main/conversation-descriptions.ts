import { randomUUID } from 'node:crypto';
import type { ChatExecution, ChatWorkerInput } from '../shared/chat';
import { DESCRIPTION_INSTRUCTIONS, descriptionTranscript, parseDescription } from '../core/conversation-description';
import type { HistoryStore } from './history';

export type DescriptionConnection = Pick<ChatWorkerInput, 'route' | 'endpoint' | 'model' | 'secret' | 'protocol' | 'provider' | 'contextWindowTokens' | 'openrouter' | 'reasoning'>;

/** One low-priority, cancellable request at a time. Foreground replies always
 * preempt this queue, including local servers that have only one model slot. */
export class ConversationDescriptions {
  private queue = new Map<string, DescriptionConnection>();
  private attempted = new Map<string, { head: string; connection: string; at: number }>();
  private timer?: ReturnType<typeof setTimeout>;
  private active?: { id: string; connection: DescriptionConnection; controller: AbortController; done: Promise<void> };
  private paused = false;
  private closed = false;
  constructor(private history: HistoryStore, private execution: ChatExecution, private changed: (id: string) => void) {}

  schedule(id: string, connection: DescriptionConnection): void {
    if (this.closed) return;
    this.queue.set(id, connection);
    if (this.queue.size > 8) this.queue.delete(this.queue.keys().next().value!);
    this.kick();
  }
  pause(): void {
    this.paused = true; clearTimeout(this.timer); this.timer = undefined;
    if (this.active) { this.queue.set(this.active.id, this.active.connection); this.attempted.delete(this.active.id); this.active.controller.abort(); }
  }
  resume(): void { this.paused = false; this.kick(); }
  private kick(): void {
    if (this.closed || this.paused || this.active || this.timer || !this.queue.size) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.next(); }, 750);
  }
  private next(): void {
    if (this.closed || this.paused || this.active) return;
    const entry = this.queue.entries().next().value;
    if (!entry) return;
    const [id, connection] = entry; this.queue.delete(id);
    const controller = new AbortController();
    const active = { id, connection, controller, done: Promise.resolve() };
    this.active = active;
    active.done = this.generate(id, connection, controller).catch(() => { /* Optional metadata never fails a reply or opens an error banner. */ }).finally(() => {
      if (this.active === active) this.active = undefined;
      this.kick();
    });
  }
  private async generate(id: string, connection: DescriptionConnection, controller: AbortController): Promise<void> {
    const state = this.history.descriptionState(id);
    if (!state?.headId) return;
    const conversation = this.history.conversation(id);
    const last = conversation.messages.at(-1);
    if (last?.role !== 'assistant' || last.status !== 'complete') return;
    // Never send a formerly local conversation to a remote connection.
    if (last.route !== connection.route || !connection.model) return;
    const completedTurns = conversation.messages.filter(message => message.role === 'assistant' && message.status === 'complete').length;
    if (!completedTurns || !conversation.messages.some(message => message.role === 'user' && message.text.trim() && !/^(?:hi|hello|hey|thanks|thank you|okay|ok)[!?.\s]*$/i.test(message.text.trim()))) return;
    const throughIndex = conversation.messages.findIndex(message => message.id === state.throughId);
    const covered = throughIndex >= 0;
    // Refresh early clarifications, then a rolling summary at bounded intervals.
    // Explicit changes of subject can refresh between these milestones.
    const latestUser = [...conversation.messages].reverse().find(message => message.role === 'user')?.text ?? '';
    const pivot = /\b(?:new topic|different topic|switch(?:ing)? (?:to|topics)|instead|moving on|next[, :]|now[, :])\b/i.test(latestUser);
    const due = !covered || completedTurns <= 3 && completedTurns > state.completedTurns || completedTurns - state.completedTurns >= (completedTurns <= 6 ? 3 : 5) || pivot && completedTurns > state.completedTurns;
    if (!due || state.throughId === state.headId) return;
    const attempt = this.attempted.get(id);
    // A freshly booted local server has a new endpoint. A failed startup attempt
    // must not suppress the now-ready connection for another five minutes.
    const connectionKey = JSON.stringify([connection.route, connection.endpoint, connection.model, connection.protocol, connection.provider, connection.reasoning]);
    if (attempt?.head === state.headId && attempt.connection === connectionKey && Date.now() - attempt.at < 300000) return;
    this.attempted.set(id, { head: state.headId, connection: connectionKey, at: Date.now() });
    if (this.attempted.size > 200) this.attempted.delete(this.attempted.keys().next().value!);
    const input: ChatWorkerInput = {
      ...connection, runId: randomUUID(), purpose: 'metadata', tools: false, maxOutputTokens: 512,
      instructions: DESCRIPTION_INSTRUCTIONS,
      messages: [{ role: 'user', text: JSON.stringify({ existingTitle: state.titleSource === 'fallback' ? '' : conversation.title, previousSummary: covered ? state.summary : '', transcript: descriptionTranscript(conversation.messages, Math.min(6000, Math.floor((connection.contextWindowTokens ?? 8192) * .7))) }) }],
    };
    let text = '';
    let lane = 'answer';
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      await this.execution.run(input, controller.signal, delta => { if (lane !== 'progress') text += delta; if (text.length > 4000) throw new Error('Description exceeded its limit.'); }, undefined, undefined, event => {
        if (event.type === 'start') { lane = event.lane; text = ''; }
      });
      controller.signal.throwIfAborted();
      const description = parseDescription(text);
      const changeTitle = state.titleSource === 'fallback' || description.topicChanged && (completedTurns <= 3 || completedTurns - state.titleTurns >= 5);
      if (this.history.saveDescription(id, { headId: state.headId, revision: state.revision }, description, completedTurns, changeTitle)) this.changed(id);
    } finally { clearTimeout(timeout); }
  }
  async shutdown(): Promise<void> {
    this.closed = true; clearTimeout(this.timer); this.timer = undefined; this.queue.clear(); this.attempted.clear();
    this.active?.controller.abort(); await this.active?.done;
  }
}
