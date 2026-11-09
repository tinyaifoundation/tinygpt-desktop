import type { CompactionResult, ExtensionFactory, SessionBeforeCompactEvent, SessionBoundaryDraft, SessionManager } from '@earendil-works/pi-coding-agent';
import type { ChatWorkerInput } from '../shared/chat';
import type { TraceEvent } from '../shared/diagnostics';
import { ObservationStore } from './observations';
import { contextPolicy } from '../core/context';
import { workContextPolicy } from '../core/work-context-policy';

/** Repair the old host projection, never the original call or files on disk.
 * Only a matching raw call can supply the actual arguments. Run on the selected
 * fork before creating the agent, so existing chats also stop seeing fake code. */
export function repairWorkArgumentHistory(manager: SessionManager): number {
  let repaired = 0;
  for (const entry of manager.buildSessionProjection().entries) {
    const message = entry.messages[0], source = entry.sourceEntry;
    if (source.type !== 'message' || source.message.role !== 'assistant' || message?.role !== 'assistant') continue;
    const originalContent = source.message.content;
    let changed = false;
    const content = message.content.map(part => {
      if (part.type !== 'toolCall' || !['write', 'edit'].includes(part.name)) return part;
      const legacy = part.name === 'write'
        ? typeof part.arguments.content === 'string' && /^\[Completed write; exact arguments: read_observation id=[a-f0-9-]{36}\]$/i.test(part.arguments.content)
        : Array.isArray(part.arguments.edits) && part.arguments.edits.length === 1 && /^\[Completed edit; exact arguments: read_observation id=[a-f0-9-]{36}\]$/i.test(part.arguments.edits[0]?.oldText ?? '') && part.arguments.edits[0]?.newText === '[See archived arguments.]';
      if (!legacy) return part;
      const original = originalContent.find(candidate => candidate.type === 'toolCall' && candidate.id === part.id && candidate.name === part.name);
      if (original?.type !== 'toolCall' || JSON.stringify(original.arguments) === JSON.stringify(part.arguments)) return part;
      changed = true; return { ...part, arguments: original.arguments };
    });
    if (changed) { manager.appendContextEdit(source.id, { content }); repaired++; }
  }
  return repaired;
}

/** Branch-local, append-only context edits. Raw Pi session entries stay intact. */
export function workContextExtension(store: ObservationStore, input: ChatWorkerInput, workspace: string, compact: (event: SessionBeforeCompactEvent) => Promise<CompactionResult>, trace?: (event: TraceEvent) => void): ExtensionFactory {
  const canRetireThinking = (part: { type: string; thinking?: string; thinkingSignature?: string }) => input.provider === 'local' && input.protocol === 'openai-compatible' && input.reasoning?.kind === 'llamacpp' && part.type === 'thinking' && (part.thinking?.length ?? 0) >= 2500 && (!part.thinkingSignature || part.thinkingSignature === 'reasoning_content') && !part.thinking?.startsWith('[Completed reasoning archived:');
  return pi => {
    pi.on('session_before_compact', async event => ({ compaction: await compact(event) }));
    pi.on('context', (event, context) => {
      const edit = context.sessionManager.getBranch().slice().reverse().find(entry => entry.type === 'context_edit');
      if (!edit) return;
      const changedAt = Date.parse(edit.timestamp);
      // pi-ai sizes output from assistant usage independently of Pi's branch
      // estimator. Usage predating a projection edit describes a different prompt.
      // Invalidate only that sizing hint; raw session usage and wire content stay intact.
      return { messages: event.messages.map(message => message.role === 'assistant' && message.timestamp <= changedAt
        ? { ...message, usage: { ...message.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } }
        : message) };
    });
    pi.on('turn_end', async (event, context) => {
      const policy = contextPolicy(input);
      const cleanup = workContextPolicy(policy.window, policy.outputTokens, policy.inputTokens);
      const usage = context.getContextUsage()?.tokens;
      // Editing an old message also invalidates computed state after it. Do
      // not trade a healthy warm prefix for a smaller prompt. Unknown usage
      // stays with Pi's native compaction rather than guessing from characters.
      if (typeof usage !== 'number' || !Number.isFinite(usage) || usage < cleanup.cleanupTriggerTokens) return;
      const entries: SessionBoundaryDraft[] = [];
      const projected = event.context.contextEntries;
      const recent = new Set(projected.slice(-8).map(entry => entry.sourceEntry.id));
      const eligible = projected.filter(entry => !recent.has(entry.sourceEntry.id) && entry.sourceEntry.type === 'message');
      const resultEntries = new Map(eligible.flatMap(entry => {
        const result = entry.messages[0];
        return result?.role === 'toolResult' && !result.isError && result.content.every(part => part.type === 'text') ? [[result.toolCallId, { entry, result }] as const] : [];
      }));
      const canRetireCall = (part: { type: string; id?: string; name?: string; arguments?: unknown }) => part.type === 'toolCall' && ['write', 'edit'].includes(part.name ?? '') && resultEntries.get(part.id ?? '')?.result.toolName === part.name && JSON.stringify(part.arguments ?? {}).length >= 4000;
      const potential = eligible.reduce((sum, entry) => {
        const message = entry.messages[0];
        if (message?.role === 'toolResult' && !message.isError && message.toolName !== 'read_observation' && message.content.every(part => part.type === 'text')) return sum + Math.max(0, message.content.reduce((chars, part) => chars + (part.type === 'text' ? part.text.length : 0), 0) - 1300);
        if (message?.role === 'assistant' && input.provider === 'local' && input.protocol === 'openai-compatible' && ['stop', 'toolUse'].includes(message.stopReason)) return sum + message.content.reduce((chars, part) => chars + (part.type === 'thinking' && canRetireThinking(part) ? part.thinking.length - 300 : canRetireCall(part) ? JSON.stringify(part).length - 900 : 0), 0);
        return sum;
      }, 0);
      // Require a meaningful batch as well as pressure. Character estimates
      // decide whether to attempt cleanup, never model capacity or cache hits.
      const requiredSaving = Math.max(512, usage - cleanup.cleanupTargetTokens);
      // A marginal edit pays the prefix-rebuild cost without making enough
      // headroom. Leave the branch intact for Pi's next-request compaction.
      if (potential / 4 < requiredSaving) return;
      let savedCharacters = 0;
      const retiredResults = new Set<string>();
      for (const entry of eligible) {
        if (retiredResults.has(entry.sourceEntry.id)) continue;
        const message = entry.messages[0];
        if (!message || !('content' in message) || !Array.isArray(message.content)) continue;
        if (message.role === 'toolResult' && !message.isError && message.toolName !== 'read_observation') {
          if (!message.content.every(part => part.type === 'text')) continue;
          const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
          if (text.length < 2500) continue;
          // Existing references already bound this observation and remain retrievable.
          let record;
          try { const id = JSON.parse(text).observationId; if (id) record = await store.get(input.conversationId!, id); } catch {}
          record ??= await store.save({ conversationId: input.conversationId!, runId: input.runId, tool: message.toolName, text, permission: /browser|page|web/.test(message.toolName) ? 'browser' : 'read', workspace });
          const replacement = store.excerpt(record, 800);
          entries.push({ type: 'context_edit', targetId: entry.sourceEntry.id, replacement: { content: [{ type: 'text', text: replacement }] } });
          savedCharacters += Math.max(0, text.length - replacement.length);
        }
        // Retire a completed call/result pair together. The archive notice is
        // ordinary history text, never substituted into executable arguments.
        // Signed provider histories, failed/pending calls and recent pairs stay intact.
        if (message.role === 'assistant' && input.provider === 'local' && input.protocol === 'openai-compatible' && ['stop', 'toolUse'].includes(message.stopReason)) {
          let changed = false;
          const content = [];
          for (const part of message.content) {
            if (part.type === 'thinking' && ['stop', 'toolUse'].includes(message.stopReason) && canRetireThinking(part)) {
              const record = await store.save({ conversationId: input.conversationId!, runId: input.runId, tool: 'completed reasoning', text: part.thinking, permission: 'read', workspace });
              const thinking = `[Completed reasoning archived: read_observation id=${record.id}. Completed actions and outcomes remain in the transcript. Retrieve exact reasoning only if needed.]`;
              content.push({ ...part, thinking }); savedCharacters += part.thinking.length - thinking.length; changed = true; continue;
            }
            if (part.type !== 'toolCall' || !canRetireCall(part)) { content.push(part); continue; }
            const { entry: resultEntry, result } = resultEntries.get(part.id)!;
            const record = await store.save({ conversationId: input.conversationId!, runId: input.runId, tool: part.name + ' completed action', text: JSON.stringify({ kind: 'completed_action', tool: part.name, toolCallId: part.id, arguments: part.arguments, result: { content: result.content, isError: false } }), permission: 'read', workspace, paths: typeof part.arguments.path === 'string' ? [part.arguments.path] : [] });
            const text = `Completed ${part.name} action (succeeded; historical execution metadata, not file contents): ${JSON.stringify({ toolCallId: part.id, path: part.arguments.path, observationId: record.id })}. Exact arguments and result: read_observation id=${record.id}. Read the current file before making another change; do not write this archive note into a file.`;
            content.push({ type: 'text' as const, text });
            entries.push({ type: 'context_edit', targetId: resultEntry.sourceEntry.id, replacement: null });
            retiredResults.add(resultEntry.sourceEntry.id);
            savedCharacters += JSON.stringify(part).length + JSON.stringify(result.content).length - text.length; changed = true;
          }
          if (changed) entries.push({ type: 'context_edit', targetId: entry.sourceEntry.id, replacement: { content } });
        }
      }
      if (savedCharacters / 4 < requiredSaving) return;
      if (entries.length) trace?.({ event: 'context-pruned', savedCharacters: Math.max(0, savedCharacters) });
      return entries.length ? { entries } : undefined;
    });
  };
}
