import { useRef, useMemo } from 'react';
import type { ThreadMessageLike } from '@assistant-ui/react';
import type { ChatMessage, Conversation, LibrarySnapshot } from '../../shared/chat';
import type { MessageDetails } from '../components/ConversationMessages';
import { collectCitations, type CitationSource } from '../../core/citations';
import { hasStartedAnswer, holdAnswerText } from '../../core/answer-visibility';
import { botMessageText } from '../../core/bot-messages';
import { generativeAnswerParts } from '../../core/generative-parts';
import { workSteeringMessageIds } from '../../core/work-activity';
import { chatPresentation } from '../../core/chat-presentation';

export function useMessages(conversation: Conversation | null, activeRun: LibrarySnapshot['activeRuns'][number] | undefined) {
  const cache = useRef(new Map<string, { message: ChatMessage; details: MessageDetails; value: ThreadMessageLike; toolsBase: Conversation['tools']; sourcesBase: Conversation['sources']; contextsBase: Conversation['contextActivities'] }>());
  return useMemo(() => {
    let previousDay = '';
    let previousCitations: CitationSource[] = [];
    const inherited = new Map<string, CitationSource[]>();
    const byId = new Map((conversation?.allMessages ?? conversation?.messages)?.map(message => [message.id, message]));
    const children = new Set((conversation?.messages ?? []).flatMap(message => [message.parentId, message.continuationOf].filter((id): id is string => !!id)));
    const botParents = new Set((conversation?.messages ?? []).filter(message => message.role === 'assistant').map(message => `${message.parentId}:${message.runId}`));
    const toolsByRun = new Map<string | null, Conversation['tools']>();
    for (const tool of conversation?.tools ?? []) { const grouped = toolsByRun.get(tool.runId) ?? []; grouped.push(tool); toolsByRun.set(tool.runId, grouped); }
    const contextsByRun = new Map<string | null, NonNullable<Conversation['contextActivities']>>();
    for (const activity of conversation?.contextActivities ?? []) { const grouped = contextsByRun.get(activity.runId) ?? []; grouped.push(activity); contextsByRun.set(activity.runId, grouped); }
    const ids = new Set<string>();
    const steeringIds = workSteeringMessageIds(conversation?.allMessages ?? conversation?.messages ?? []);
    const result = (conversation?.messages ?? []).filter(message => !steeringIds.has(message.id)).map(message => {
      ids.add(message.id);
      previousCitations = inherited.get(message.parentId ?? '') ?? [];
      const canDiscard = !children.has(message.id);
      const live=message.role==='assistant'&&message.status==='streaming'&&message.runId===activeRun?.runId;
      const visualAnswerStarted = (toolsByRun.get(message.runId) ?? []).some(tool => tool.name === 'present' && ['pending', 'running', 'success'].includes(tool.status));
      const prose = live ? conversation?.mode==='code'||conversation?.mode==='bot' ? activeRun!.prose??'' : chatPresentation(message,activeRun,byId.get(message.continuationOf??'')?.text,visualAnswerStarted).progress : '';
      const unclassifiedText = holdAnswerText(message, activeRun);
      const workRunning = message.status === 'streaming' && message.runId === activeRun?.runId && (!hasStartedAnswer(message, activeRun) || conversation?.mode === 'chat' && activeRun.phase !== 'answer');
      const reasoningRunning = workRunning && activeRun?.phase === 'thinking';
      const phase = message.status === 'streaming' && message.runId === activeRun?.runId ? activeRun.phase : undefined;
      const date = new Date(message.createdAt);
      const dayKey = date.toDateString();
      const day = dayKey === previousDay ? null : dayKey === new Date().toDateString() ? 'Today' : date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
      previousDay = dayKey;
      const cached = cache.current.get(message.id);
      if (cached?.message === message && cached.details.day === day && cached.toolsBase === conversation?.tools && cached.sourcesBase === conversation?.sources && cached.contextsBase === conversation?.contextActivities && cached.details.canDiscard === canDiscard && cached.details.phase === phase && cached.details.prose === prose && cached.details.unclassifiedText === unclassifiedText && cached.details.workRunning === workRunning && cached.details.mode === conversation?.mode && (cached.details.ownCitations?.length || !previousCitations.length && !cached.details.citations?.length || cached.details.citations === previousCitations)) {
        if (cached.details.ownCitations?.length) previousCitations = cached.details.ownCitations;
        inherited.set(message.id, previousCitations); return cached.value;
      }
      const runs = new Set([message.runId]); let prior = message.continuationOf; const seen = new Set<string>();
      while (prior && !seen.has(prior)) { seen.add(prior); const original = byId.get(prior); if (!original) break; runs.add(original.runId); prior = original.continuationOf; }
      const laterBotReply = conversation?.mode === 'bot' && botParents.has(`${message.id}:${message.runId}`);
      const tools = message.role === 'assistant' && !laterBotReply ? [...runs].reverse().flatMap(run => toolsByRun.get(run) ?? []) : [];
      const contextActivities = message.role === 'assistant' ? [...runs].reverse().flatMap(run => contextsByRun.get(run) ?? []) : [];
      const sources = (conversation?.sources ?? []).filter(source => message.role === 'user' ? message.attachmentIds?.includes(source.id) || source.messageId === message.id : message.text.includes(`tinygpt-source:${source.id}`) || tools.some(tool => tool.result?.includes(source.id)));
      let saved = cache.current.get(message.id);
      if (saved?.details.phase !== phase || saved?.details.mode !== conversation?.mode || JSON.stringify(saved?.message.citations) !== JSON.stringify(message.citations)) saved = undefined;
      if (saved && (saved.details.contextActivities?.length !== contextActivities.length || saved.details.contextActivities?.some((activity, index) => activity.id !== contextActivities[index]?.id || activity.status !== contextActivities[index]?.status))) saved = undefined;
      if (saved && saved.message.workTask?.revision !== message.workTask?.revision) saved = undefined;
      if (saved && (JSON.stringify(saved.message.reactions) !== JSON.stringify(message.reactions) || saved.details.prose !== prose || saved.details.unclassifiedText !== unclassifiedText || saved.message.workDurationMs !== message.workDurationMs || saved.details.canDiscard !== canDiscard || saved.details.workRunning !== workRunning || JSON.stringify(saved.message.workActivity) !== JSON.stringify(message.workActivity) || JSON.stringify(saved.message.presentations) !== JSON.stringify(message.presentations))) saved = undefined;
      // A following answer's citation context changes when prior evidence is removed/refreshed.
      if (saved && message.role === 'assistant' && !saved.details.ownCitations?.length && (previousCitations.length || saved.details.citations?.length) && saved.details.citations !== previousCitations) saved = undefined;
      if (saved && saved.message.text === message.text && saved.message.reasoning === message.reasoning && saved.message.status === message.status && saved.message.error === message.error && saved.message.createdAt === message.createdAt && saved.details.day === day && saved.details.reasoningRunning === reasoningRunning && saved.details.sources.length === sources.length && saved.details.sources.every((source, index) => source.id === sources[index]?.id && source.title === sources[index]?.title && source.url === sources[index]?.url) && saved.details.tools.length === tools.length && saved.details.tools.every((tool, index) => tool.id === tools[index]?.id && tool.status === tools[index]?.status && tool.summary === tools[index]?.summary && tool.result === tools[index]?.result && tool.displayText === tools[index]?.displayText && tool.target === tools[index]?.target && tool.previewImage === tools[index]?.previewImage && tool.iconKey === tools[index]?.iconKey && JSON.stringify(tool.remotePresentation) === JSON.stringify(tools[index]?.remotePresentation) && JSON.stringify(tool.sites) === JSON.stringify(tools[index]?.sites))) {
        if (saved.details.ownCitations?.length) previousCitations = saved.details.ownCitations;
        inherited.set(message.id, previousCitations);
        return saved.value;
      }
      const ownCitations = message.role === 'assistant' ? message.citations ?? collectCitations(tools, conversation?.sources ?? [], message.text) : [];
      const citations = ownCitations.length ? ownCitations : message.role === 'assistant' ? previousCitations : [];
      if (ownCitations.length) previousCitations = ownCitations;
      inherited.set(message.id, previousCitations);
      const details: MessageDetails = { reactions: message.reactions, mode: conversation?.mode, status: message.status, error: message.error, day, sources, tools, contextActivities, reasoningRunning, workRunning, citations, ownCitations, prose, unclassifiedText, phase, workDurationMs: message.workDurationMs, workActivity: message.workActivity, workTask: message.workTask, canDiscard };
      const value: ThreadMessageLike = {
        id: message.id, role: message.role, createdAt: date,
        content: [...(message.reasoning ? [{ type: 'reasoning' as const, text: message.reasoning }] : []), ...(conversation?.mode === 'code' || conversation?.mode === 'bot' && message.role === 'assistant' ? [{ type: 'text' as const, text: conversation?.mode === 'bot' ? botMessageText({ content: message.text }) : message.text }] : generativeAnswerParts(message, tools, byId))],
        metadata: { custom: { desktop: details } },
        ...(message.role === 'assistant' ? { status: message.status === 'streaming' ? { type: 'running' as const } : message.status === 'complete' ? { type: 'complete' as const, reason: 'stop' as const } : { type: 'incomplete' as const, reason: ['cancelled', 'interrupted'].includes(message.status) ? 'cancelled' as const : 'error' as const, ...(message.status === 'error' ? { error: message.error ?? 'This reply did not finish.' } : {}) } } : {}),
      };
      cache.current.set(message.id, { message, details, value, toolsBase: conversation?.tools ?? [], sourcesBase: conversation?.sources ?? [], contextsBase: conversation?.contextActivities });
      return value;
    });
    for (const id of cache.current.keys()) if (!ids.has(id)) cache.current.delete(id);
    return result;
  }, [conversation, activeRun]);
}
