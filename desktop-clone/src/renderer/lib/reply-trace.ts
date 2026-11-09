import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import type { Conversation, LibrarySnapshot } from '../../shared/chat';
import type { DesktopBridge } from '../../shared/contracts';
import { holdAnswerText } from '../../core/answer-visibility';

/** Acknowledge rendered state only. No DOM text leaves the renderer. */
export function useReplyTrace(bridge: DesktopBridge, conversation: Conversation | null, library: LibrarySnapshot, root: RefObject<HTMLDivElement | null>) {
  const latest = useRef({ conversation, library }); latest.current = { conversation, library };
  const pending = useRef(0); const sent = useRef({ key: '', at: 0 });
  const schedule = useCallback((cause: 'snapshot' | 'content' | 'interaction' = 'snapshot') => {
    const stamp = latest.current.conversation?.diagnostics;
    if (!stamp || pending.current) return;
    const receivedAt = Date.now(); const scheduledAt = performance.now();
    pending.current = requestAnimationFrame(() => {
      pending.current = requestAnimationFrame(() => {
        pending.current = 0;
        const current = latest.current;
        if (stamp.runId !== current.conversation?.diagnostics?.runId || !root.current?.isConnected) return;
        const message = current.conversation ? [...current.conversation.messages].reverse().find(item => item.role === 'assistant' && item.runId === stamp.runId) : undefined;
        if (!message) return;
        const element = root.current.querySelector(`[data-message-id="${message.id}"]`);
        const answer = element?.querySelector('[data-slot="answer-text"]');
        const viewport = root.current.querySelector('.thread-viewport');
        const box = element?.getBoundingClientRect(); const bounds = viewport?.getBoundingClientRect() ?? root.current.getBoundingClientRect();
        const visible = (node: Element | null | undefined) => { if (!node?.getClientRects().length) return false; const box = node.getBoundingClientRect(); return box.bottom > bounds.top && box.top < bounds.bottom; };
        const visibility = document.hidden ? 'background' : !box || box.bottom < bounds.top || box.top > bounds.bottom ? 'offscreen' : 'foreground';
        const active = current.library.activeRuns.find(run => run.runId === stamp.runId);
        const fields = {
          phase: active?.phase,
          visibility, answerVisible: visible(answer) && !!message.text.trim() && !holdAnswerText(message, active) && !!answer?.textContent?.trim(),
          workVisible: visible(element?.querySelector('[data-slot="work-summary"], [data-slot="work-status"], [data-slot="context-optimization"][data-status="running"]')),
          thinkingVisible: visible(element?.querySelector('[data-slot="thinking"]')),
          approvalVisible: current.library.approvals.some(item => item.runId === stamp.runId) && visible(root.current.querySelector('[data-slot="permission-grant"], [data-slot="plugin-use-card"][data-status="pending"]')),
          errorVisible: visible(element?.querySelector('[data-slot="error-state"]')),
          textHeld: holdAnswerText(message, active) && !!message.text,
        } as const;
        const key = `${stamp.runId}:${JSON.stringify(fields)}`;
        if (key === sent.current.key && Date.now() - sent.current.at < 2000) return;
        sent.current = { key, at: Date.now() };
        void bridge.recordReplyFrame({ ...fields, cause, runId: stamp.runId, updateId: stamp.updateId,
          deliveryMs: Math.max(0, receivedAt - stamp.publishedAt), renderMs: Math.max(0, performance.now() - scheduledAt) }).catch(() => {});
      });
    });
  }, [bridge, root]);
  useLayoutEffect(schedule, [conversation, library, schedule]);
  useLayoutEffect(() => {
    const node = root.current; if (!node) return;
    // External-store message content can commit after Workbench's own update.
    const observer = new MutationObserver(changes => schedule(changes.some(change => change.attributeName === 'open') ? 'interaction' : 'content')); observer.observe(node, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'open', 'hidden'] });
    const interaction = () => schedule('interaction');
    node.addEventListener('scroll', interaction, true); document.addEventListener('visibilitychange', interaction);
    return () => { observer.disconnect(); node.removeEventListener('scroll', interaction, true); document.removeEventListener('visibilitychange', interaction); if (pending.current) cancelAnimationFrame(pending.current); pending.current = 0; };
  }, [root, schedule]);
}
