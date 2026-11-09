import { browserActivityLabel } from '../../shared/browser-tool-labels';
import { hasToolPreview } from '../../core/tool-preview';
import { ToolImagePreview } from './ToolImagePreview';
import { MessageAttachments } from './MessageAttachments';
import { GeneratedImages } from './GeneratedImages';
import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActionBarPrimitive, MessageByIndexProvider, MessagePrimitive, useAuiState } from '@assistant-ui/react';
import { MarkdownText, MarkdownBody } from './AnswerMarkdown';
import { answerMarkdown, presentationText } from '../../core/answer-content';
import { Check, ChevronDown, Copy, Download, Lightbulb, MoreHorizontal, Pencil, RotateCcw } from '../icons';
import { useToolIcon } from '../tool-icons';
import { computerToolLabel, isComputerTool } from '../../shared/computer';
import type { DesktopBridge } from '../../shared/contracts';
import type { ChatUpdate } from '../../shared/chat';
import { PluginConnectionCards, pluginConnectionRequests } from './PluginConnectionCards';
import { SkillDraftCards } from './SkillDraftCards';
import { RevoteIcon } from '@solar-icons/react/linear/revote';
import type { ContextActivity, MessageStatus } from '../../shared/chat';
import type { SourceSummary, ToolActivity } from '../../shared/tools';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { collectCitations, sourceDomain, sourceUrl, type CitationSource } from '../../core/citations';
import { FaviconStack, MessageCitations, MessageSources } from './MessageCitations';
import { formatWorkDuration } from '../../core/work-duration';
import { ControlTooltip } from './ui/tooltip';
import { EditMessage, MessageBranches, StoppedReplyNotice, TypingIndicator } from './ConversationElements';
import { MessageErrorState, MessageNotice } from './elements/error-state';
import { CreatedFileCards } from './CreatedFileCards';
import type { CreatedFile } from '../../core/created-files';
import { codeToolLabel } from '../../core/code-progress';
import { CodeTurnProgress } from './CodeTurnProgress';
import { ReadAloudButton } from './ReadAloud';
import { WorkResponse } from './WorkResponse';
import { ComputerToolResult } from './ComputerToolResult';

export interface MessageDetails {
  mode?: string;
  reactions?: import('../../shared/bot-reactions').MessageReaction[];
  status: MessageStatus; error: string | null; day: string | null;
  sources: SourceSummary[]; tools: ToolActivity[];
  citations?: CitationSource[]; ownCitations?: CitationSource[];
  reasoningRunning?: boolean;
  phase?: import('../../shared/chat').ActiveRun['phase'];
  workRunning?: boolean;
  prose?: string; unclassifiedText?: boolean; workDurationMs?: number | null;
  canDiscard?: boolean;
  contextActivities?: ContextActivity[];
  workTask?: import('../../shared/work').WorkTask;
  workActivity?: import('../../shared/chat').WorkActivity[];
}
const conversationActions = {
  loadPresentation: null as ((conversationId: string, toolId: string, signal?: AbortSignal) => Promise<{ ui: import('../../shared/generative-ui').ChatUINode; partial: boolean }>) | null,
  previewTool: null as ((conversationId:string,toolId:string)=>Promise<import('../../shared/remote-media').ToolImagePreview>) | null,
  react: (_messageId: string, _emoji: import('../../shared/bot-reactions').MessageReaction['emoji'] | null) => {},
  answerStartedId: '',
  bridge: null as DesktopBridge | null, connectionUpdated: (_value: ChatUpdate) => {},
  openFile: (_file: CreatedFile) => {},
  setDraft: (_text: string) => {}, retry: (_id: string) => {}, continueReply: (_id: string) => {}, discardReply: (_id: string) => {}, retryDisabled: false, openSource: (_id: string) => {}, openWeb: (_url: string) => {}, exportAnswer: (_id: string) => {},
  matches: new Set<string>(), selectedMatch: '',
};
export const ConversationActions = createContext<typeof conversationActions & { previewAttachment?: (conversationId:string,sourceId:string,full:boolean)=>Promise<import('../../shared/remote-media').ToolImagePreview> }>(conversationActions);
const messageComponents = { Text: MarkdownText, Reasoning: () => null };
const heldMessageComponents = { ...messageComponents, Text: () => null };
function CopyMessage({ user = false }: { user?: boolean }) {
  const copied = useAuiState(s => s.message.isCopied);
  const { message, details } = MessageState();
  const [answerCopied, setAnswerCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (answerCopied) { const timer = setTimeout(() => setAnswerCopied(false), 2000); return () => clearTimeout(timer); } }, [answerCopied]);
  if (user) return <ControlTooltip label={copied ? 'Copied' : 'Copy message'}><ActionBarPrimitive.Copy asChild><Button variant="ghost" size="icon" className="message-control size-7 rounded-full text-muted-foreground" aria-label="Copy message">{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}</Button></ActionBarPrimitive.Copy></ControlTooltip>;
  const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n\n');
  const content = answerMarkdown(text, details.tools.filter(tool => message.content.some(part => part.type === 'tool-call' && part.toolCallId === tool.id)));
  return <ControlTooltip label={failed ? 'Copy unavailable' : answerCopied ? 'Copied' : 'Copy answer'}><Button variant="ghost" size="icon" className="message-control size-7 rounded-full text-muted-foreground" aria-label="Copy answer" disabled={!content} onClick={() => { void navigator.clipboard.writeText(content).then(() => { setAnswerCopied(true); setFailed(false); }, () => setFailed(true)); }}>{answerCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}</Button></ControlTooltip>;
}
function DayBreak({ day }: { day: string | null }) { return day ? <div className="mb-7 text-center text-[11px] text-muted-foreground">{day}</div> : null; }
function MessageState() {
  const message = useAuiState(s => s.message);
  const actions = useContext(ConversationActions);
  const details = (message.metadata.custom.desktop as MessageDetails | undefined) ?? { status: 'complete', error: null, day: null, sources: [], tools: [] };
  return { message, actions, details };
}
export function Shimmer({ active = true, children }: { active?: boolean; children: React.ReactNode }) { return <span className={active ? 'shimmer' : undefined}>{children}</span>; }
export function ContextOptimization({ activity }: { activity: ContextActivity }) {
  return <div data-slot="context-optimization" data-status={activity.status} role={activity.status === 'running' ? 'status' : undefined} className="flex items-center gap-2 py-1 text-sm text-muted-foreground"><RevoteIcon aria-hidden="true" strokeWidth={1.25} className="size-4 shrink-0" /><Shimmer active={activity.status === 'running'}>{activity.status === 'error' ? 'Conversation optimization could not finish' : activity.status === 'interrupted' ? 'Conversation optimization interrupted' : activity.status === 'complete' ? 'Optimized the conversation' : 'Automatically optimizing conversation'}</Shimmer>{activity.status === 'complete' && <Check aria-label="Complete" className="size-3.5" />}</div>;
}
export function Reasoning({ text, status, nested = false }: { text: string; status: { type: string }; nested?: boolean }) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const { answerStartedId } = useContext(ConversationActions);
  useLayoutEffect(() => { if (disclosure.current) disclosure.current.open = false; }, [answerStartedId]);
  return <details ref={disclosure} data-slot="thinking" className={`thinking-step group/tool text-muted-foreground ${nested ? '' : 'mb-4 text-sm'}`}><summary className="flex w-fit max-w-full cursor-pointer items-center gap-2"><Lightbulb aria-hidden="true" strokeWidth={1.25} className="size-4 shrink-0 opacity-60" /><Shimmer active={status.type === 'running'}>{status.type === 'running' ? 'Thinking…' : 'Thought'}</Shimmer><span className="tool-result-caret flex size-6 shrink-0 items-center justify-center rounded-md opacity-0 transition-opacity group-hover/tool:opacity-100 group-focus-within/tool:opacity-100"><ChevronDown aria-hidden="true" className="size-4" /></span></summary><ScrollArea className="mt-2 border-l-2" viewportClassName="max-h-64"><div className="whitespace-pre-wrap pl-4 pr-3 text-[13px] leading-6">{text}</div></ScrollArea></details>;
}
const toolLabels = {
  code_delegate: ['Coding agent', 'Coding agent'],
  view_image: ['Viewing an image', 'Viewed an image'], browser_screenshot: ['Taking a screenshot', 'Took a screenshot'],
  code_read: ['Reading a file','Read a file'],code_glob:['Finding files','Found files'],code_grep:['Searching files','Searched files'],code_edit:['Editing a file','Edited a file'],code_write:['Writing a file','Wrote a file'],code_apply_patch:['Applying changes','Applied changes'],code_bash:['Running a command','Ran a command'],code_todowrite:['Updating the work plan','Updated the work plan'],
  create_project_directory: ['Creating a folder', 'Created a folder'], edit_project_file: ['Editing a file', 'Edited a file'], review_project_changes: ['Reviewing changes', 'Reviewed changes'], run_project_command: ['Running a command', 'Ran a command'],
  search_web: ['Searching the web', 'Searched the web'], read_page: ['Reading a page', 'Read a page'],
  browser_preview: ['Opening a local preview', 'Opened a local preview'], browser_open: ['Opening the browser', 'Opened the browser'], browser_navigate: ['Navigating the browser', 'Navigated the browser'], browser_scroll: ['Scrolling the page', 'Scrolled the page'], browser_hover: ['Inspecting a control', 'Inspected a control'], browser_press_key: ['Using the keyboard', 'Used the keyboard'], browser_close: ['Closing a browser tab', 'Closed a browser tab'], browser_snapshot: ['Looking at the page', 'Inspected the page'], browser_click: ['Using the browser', 'Used the browser'], browser_type: ['Filling a field', 'Filled a field'],
  list_project_files: ['Exploring project files', 'Explored project files'], read_project_file: ['Reading a file', 'Read a file'], write_project_file: ['Writing a file', 'Wrote a file'], search_sources: ['Searching your sources', 'Searched your sources'],
} as const;
const ToolResult = memo(function ToolResult({ result }: { result: string }) {
  let value: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(result); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed as Record<string, unknown>; } catch { value.text = result; }
  const rows = (Array.isArray(value.results) ? value.results : Array.isArray(value.passages) ? value.passages : []).filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  const text = typeof value.error === 'string' ? value.error : typeof value.output === 'string' ? value.output : typeof value.text === 'string' ? value.text : typeof value.path === 'string' ? value.path : '';
  const files = Array.isArray(value.files) ? value.files.map(file => typeof file === 'string' ? file : file && typeof file === 'object' && typeof file.path === 'string' ? file.path : '').filter(Boolean) : [];
  return <ScrollArea className="mt-2 rounded-xl bg-muted text-xs leading-5" viewportClassName="max-h-64"><div className="space-y-2 p-3">
    {typeof value.title === 'string' && <p className="font-medium text-foreground">{value.title}</p>}
    {text && <p className="whitespace-pre-wrap break-words">{text.slice(0, 6000)}{text.length > 6000 ? '…' : ''}</p>}
    {rows.slice(0, 12).map((row, index) => <div key={index}>{typeof row.title === 'string' && (typeof row.url === 'string' && /^https?:\/\//i.test(row.url) ? <a href={row.url} className="font-medium text-foreground underline underline-offset-2">{row.title}</a> : <p className="font-medium text-foreground">{row.title}</p>)}{typeof row.snippet === 'string' ? <p>{row.snippet.slice(0, 600)}</p> : typeof row.text === 'string' ? <p>{row.text.slice(0, 600)}</p> : null}</div>)}
    {!!files.length && <ul>{files.slice(0, 50).map((file, index) => <li key={index} className="break-words">{file}</li>)}</ul>}
    {!text && !rows.length && !files.length && <p>This step returned a result.</p>}
  </div></ScrollArea>;
});
function ToolTarget({ tool }: { tool: ToolActivity }) {
  const sites = collectCitations([tool], []);
  for (const address of tool.sites ?? []) { const safe = sourceUrl(address); if (safe && !sites.some(site=>site.domain===sourceDomain(safe))) sites.push({key:safe,url:safe,domain:sourceDomain(safe),title:'',snippet:''}); }
  const url = sourceUrl(tool.target);
  if (!sites.length && url) sites.push({ key: url, url, domain: sourceDomain(url), title: '', snippet: '' });
  const fileTool = /^(code_(read|edit|write)|read_project_file|write_project_file|edit_project_file)$/.test(tool.name);
  const target = fileTool ? tool.target?.split(/[\\/]/).at(-1) : tool.target?.replace(/^https?:\/\/(www\.)?/i, '');
  if (!sites.length && !target) return null;
  return <span className="tool-target inline-flex min-w-0 items-center gap-1.5"><FaviconStack sources={sites} />{target && <ControlTooltip label={tool.target ?? target}><span tabIndex={0} className="max-w-48 truncate rounded-md bg-foreground/6 px-1.5 py-0.5 font-mono text-[10px] leading-4 text-foreground/70">{target}</span></ControlTooltip>}</span>;
}
export function ToolRow({ tool, running }: { tool: ToolActivity; running: boolean }) {
  const [open, setOpen] = useState(false);
  const Icon = useToolIcon(tool.name);
  const preview = hasToolPreview(tool);
  const live = running && ['pending', 'running'].includes(tool.status);
  let exitCode: number | undefined;
  if (/^(code_bash|run_project_command)$/.test(tool.name)) { try { const result = JSON.parse(tool.result ?? '{}'); if (typeof result.exitCode === 'number') exitCode = result.exitCode; } catch {} }
  const failed = ['denied', 'cancelled', 'error', 'interrupted'].includes(tool.status);
  const label = failed ? tool.status === 'denied' ? 'Tool denied' : 'Tool interrupted or failed' : (browserActivityLabel(tool, live) || computerToolLabel(tool.name, live) || tool.displayText?.replaceAll(tool.target ?? '\u0000', tool.target?.split(/[\\/]/).at(-1) ?? '') || (toolLabels[tool.name as keyof typeof toolLabels] ?? [tool.summary, tool.summary])[live ? 0 : 1]);
  return <li data-tool-name={tool.name} className="group/tool min-w-0">
    <div className="flex w-fit max-w-full flex-wrap items-center gap-2"><Icon aria-hidden="true" strokeWidth={1.25} className={`size-4 shrink-0 ${live ? 'text-foreground/80' : 'opacity-60'}`} /><Shimmer active={live}>{label}</Shimmer><ToolTarget tool={tool} />
      {(tool.result || preview) && <Button variant="ghost" size="icon" className={`tool-result-caret size-6 shrink-0 rounded-md transition-opacity ${open ? '' : 'opacity-0 group-hover/tool:opacity-100 group-focus-within/tool:opacity-100'}`} data-tool-result-toggle aria-label={`${open ? 'Hide' : 'Show'} result for ${browserActivityLabel(tool) || computerToolLabel(tool.name) || tool.displayText || (toolLabels[tool.name as keyof typeof toolLabels] ?? [tool.summary, tool.summary])[1]}`} aria-expanded={open} aria-controls={`tool-result-${tool.id}`} onClick={() => setOpen(value => !value)}><ChevronDown aria-hidden="true" className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} /></Button>}
    </div>
    {exitCode !== undefined && exitCode !== 0 && <p className="mt-1 pl-6 text-xs text-destructive">Command exited with code {exitCode}.</p>}
    {failed && <p className="mt-1 pl-6 text-xs">This step was {tool.status}.</p>}
    {open && (tool.result || preview) && <div id={`tool-result-${tool.id}`} className="pl-6">{preview ? <ToolImagePreview tool={tool} /> : tool.result && (isComputerTool(tool.name) ? <ComputerToolResult result={tool.result} /> : <ToolResult result={tool.result} />)}</div>}
  </li>;
}
function ToolChain({ tools, running, reasoning, reasoningRunning, workDurationMs, mode, placeholder = false }: { tools: ToolActivity[]; running: boolean; reasoning: string; reasoningRunning: boolean; workDurationMs?: number | null; mode?: string; placeholder?: boolean }) {
  const chain = useRef<HTMLDetailsElement>(null);
  const { answerStartedId } = useContext(ConversationActions);
  useLayoutEffect(() => { if (chain.current) chain.current.open = false; }, [running, answerStartedId]);
  const rest = workDurationMs == null ? 'Worked' : `Worked for ${formatWorkDuration(workDurationMs)}`;
  const current = [...tools].reverse().find(tool => ['pending', 'running'].includes(tool.status)) ?? tools.at(-1);
  const label = (running ? (current && (browserActivityLabel(current, true) || computerToolLabel(current.name, true))) || (mode === 'code' ? current ? codeToolLabel(current, true) : 'Working…' : current?.displayText || 'Working…') : rest).replace(/\s+/g, ' ').trim();
  return <details ref={chain} data-slot={placeholder ? 'work-status' : 'tool-chain'} className="tool-chain mb-1.5 text-[13.5px] text-muted-foreground"><summary className="flex w-fit max-w-full cursor-pointer items-center gap-1.5 py-1" title={label}><span data-slot="work-summary" role={placeholder ? 'status' : undefined} className="min-w-0 truncate leading-6"><Shimmer active={running}>{label}</Shimmer></span><ChevronDown className="tool-chain-caret size-3.5 shrink-0 opacity-60" /></summary>{(tools.length > 0 || reasoning) && <ScrollArea className="tool-chain-scroll mt-2.5" viewportClassName="tool-chain-viewport"><ol aria-label="Work steps" className="tool-chain-steps space-y-2.5 pl-4 pr-3">
    {reasoning && <li><Reasoning nested text={reasoning} status={{ type: reasoningRunning ? 'running' : 'complete' }} /></li>}
    {tools.map(tool => <ToolRow key={tool.id} tool={tool} running={running} />)}</ol></ScrollArea>}</details>;
}
export function UserMessage() {
  const { message, actions, details } = MessageState();
  const editing = useAuiState(s => s.message.composer.isEditing);
  return <MessagePrimitive.Root data-message-id={message.id} data-search-match={actions.matches.has(message.id) || undefined} data-search-selected={actions.selectedMatch === message.id || undefined} className="thread-message group mb-7"><DayBreak day={details.day} /><div className="flex flex-col items-end gap-2">
    <MessageAttachments sources={details.sources} />
    {editing ? <EditMessage disabled={actions.retryDisabled} /> : <>
      {message.content.some(part=>part.type==='text'&&part.text.trim())&&<div data-slot="user-bubble" className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-muted px-4 py-2.5 text-[15px] leading-7"><MessagePrimitive.Content /></div>}
      <div className="flex h-7 items-center gap-1"><MessageBranches disabled={actions.retryDisabled} /><div className="message-actions flex items-center"><ControlTooltip label="Edit message"><ActionBarPrimitive.Edit asChild><Button variant="ghost" size="icon" className="message-control size-7 rounded-full text-muted-foreground" aria-label="Edit message" disabled={actions.retryDisabled}><Pencil className="size-3.5" /></Button></ActionBarPrimitive.Edit></ControlTooltip><CopyMessage user /></div><time className="ml-1 text-[10px] text-muted-foreground" dateTime={message.createdAt.toISOString()}>{message.createdAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div>
    </>}
  </div></MessagePrimitive.Root>;
}
export function AssistantMessage() {
  const { message, actions, details } = MessageState();
  const running = message.status?.type === 'running';
  const last = useAuiState(s => s.message.isLast);
  const nextAssistant = useAuiState(s => s.thread.messages[s.message.index + 1]?.role === 'assistant');
  const responseStart = useAuiState(s => {
    let index = s.message.index;
    if ((s.message.metadata.custom.desktop as MessageDetails | undefined)?.mode === 'bot') return index;
    // Connector resumptions append assistant messages without another user turn.
    // Use the displayed branch, rather than the full saved message graph.
    while (index > 0 && s.thread.messages[index - 1].role === 'assistant' && (s.thread.messages[index - 1].metadata.custom.desktop as MessageDetails | undefined)?.mode !== 'bot') index--;
    return index;
  });
  const continuesResponse = details.mode !== 'bot' && nextAssistant;
  const awaitingConnection = last && pluginConnectionRequests(details.tools).some(request => request.status === 'pending');
  const hasText = !details.unclassifiedText && message.content.some(part => part.type === 'text' && part.text.trim());
  const workAnswerStarted = hasText && (details.phase === 'answer' || details.status === 'complete');
  const hasAnswerContent = hasText || details.tools.some(tool => message.content.some(part => part.type === 'tool-call' && part.toolCallId === tool.id) && (presentationText(tool) || tool.remotePresentation?.available));
  const hasReasoning = message.content.some(part => part.type === 'reasoning' && part.text.trim());
  const reasoning = message.content.filter(part => part.type === 'reasoning').map(part => part.text).join('\n\n');
  const displayTools = details.tools.filter(tool => tool.name !== 'present' && tool.name !== 'generate_image');
  const hadChain = useRef(false);
  if (displayTools.length || hasReasoning) hadChain.current = true;
  const hasChain = hadChain.current;
  const workPlaceholder = running && !hasText && !hasChain && !details.contextActivities?.some(activity => activity.status === 'running');
  const citations = details.citations ?? [];
  const citationValue = useMemo(() => ({ sources: citations, openSource: (source: CitationSource) => { if (source.url) actions.openWeb(source.url); else if (source.sourceId) actions.openSource(source.sourceId); } }), [citations, actions.openSource, actions.openWeb]);
  return <MessageCitations.Provider value={citationValue}><MessagePrimitive.Root data-message-id={message.id} data-search-match={actions.matches.has(message.id) || undefined} data-search-selected={actions.selectedMatch === message.id || undefined} className={`thread-message group ${continuesResponse ? 'mb-3' : 'mb-8'} text-[15px] leading-7`}><DayBreak day={details.day} />
    {details.mode !== 'bot' && details.mode !== 'code' && details.contextActivities?.map(activity => <div key={activity.id} className="mb-4"><ContextOptimization activity={activity} /></div>)}
    {details.mode !== 'bot' && details.mode !== 'code' && (hasChain || workPlaceholder) && <ToolChain tools={displayTools} running={workPlaceholder || !!details.workRunning} reasoning={reasoning} reasoningRunning={!!details.reasoningRunning} workDurationMs={details.workDurationMs} mode={details.mode} placeholder={workPlaceholder} />}
    {details.mode !== 'bot' && details.mode !== 'code' && running && details.prose && !hasAnswerContent && <div data-slot="chat-progress" className="break-words" aria-live="off"><MarkdownBody value={details.prose} /></div>}
    {details.mode === 'bot' && running && !hasText && <div data-slot="bot-typing-bubble" className="bot-typing-bubble"><TypingIndicator /></div>}
    {actions.bridge && <PluginConnectionCards tools={details.tools} bridge={actions.bridge} update={actions.connectionUpdated} disabled={actions.retryDisabled || !last} usageDisabled={!last} />}
    {actions.bridge && <SkillDraftCards tools={details.tools} bridge={actions.bridge} />}
    {details.status === 'interrupted' && hasText && <MessageNotice role="status" tone="muted" title="Incomplete reply"><span>This response did not finish.</span></MessageNotice>}
    {details.mode === 'code' ? <WorkResponse task={details.workTask} activity={details.workActivity ?? []} contexts={details.contextActivities} tools={displayTools} reasoning={reasoning} reasoningRunning={details.reasoningRunning} prose={details.prose} running={running} answerStarted={workAnswerStarted} status={details.status} duration={details.workDurationMs} createdAt={message.createdAt.getTime()}>
      {(workAnswerStarted || !!details.workTask && details.status !== 'streaming' || !details.workActivity?.length && !details.unclassifiedText) && <div data-slot="answer-text" className="break-words"><MessagePrimitive.Content components={messageComponents} /></div>}
    </WorkResponse> : <div data-slot="answer-text" className="break-words"><MessagePrimitive.Content components={details.unclassifiedText ? heldMessageComponents : messageComponents} /></div>}
    {actions.bridge && <GeneratedImages tools={details.tools} bridge={actions.bridge} open={actions.openSource} />}
    {details.mode === 'code' ? <CodeTurnProgress tools={details.tools} running={running} /> : <CreatedFileCards tools={details.tools} open={actions.openFile} />}
    <MessageErrorState disabled={actions.retryDisabled} allowRetry={details.mode !== 'bot'} work={details.mode === 'code'} onContinue={details.status === 'error' && details.mode === 'code' ? () => actions.continueReply(message.id) : undefined} />
    {['cancelled', 'interrupted'].includes(details.status) && details.workTask?.status !== 'awaiting-input' ? <StoppedReplyNotice interrupted={details.status === 'interrupted'} error={details.error} disabled={actions.retryDisabled} canDiscard={!!details.canDiscard} onContinue={() => actions.continueReply(message.id)} onDiscard={() => actions.discardReply(message.id)} /> : details.error && details.status !== 'error' && details.workTask?.status !== 'awaiting-input' && <MessageNotice role="status" tone="muted" title="Reply notice"><span>{details.error}</span></MessageNotice>}
    {!running && !continuesResponse && !awaitingConnection && <div data-slot="answer-actions" className={`mt-2 flex flex-wrap items-center gap-1 ${details.mode === 'code' ? 'work-answer-actions' : ''}`}>
      <MessageSources sources={details.ownCitations ?? []} />
      <MessageBranches disabled={actions.retryDisabled} />
      {Array.from({ length: message.index - responseStart }, (_, offset) => <MessageByIndexProvider key={responseStart + offset} index={responseStart + offset}><MessageBranches disabled={actions.retryDisabled} /></MessageByIndexProvider>)}
      <div className={`flex items-center gap-0 ${last ? '' : 'message-actions'}`}><CopyMessage /><ReadAloudButton messageId={message.id} disabled={!hasAnswerContent || details.status !== 'complete'} />{details.mode !== 'bot' && <ControlTooltip label="Regenerate answer"><Button variant="ghost" size="icon" className="message-control size-7 rounded-full text-muted-foreground" aria-label="Retry reply" disabled={actions.retryDisabled} onClick={() => actions.retry(message.id)}><RotateCcw className="size-3.5" /></Button></ControlTooltip>}<DropdownMenu><ControlTooltip label="More actions"><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="message-control size-7 rounded-full text-muted-foreground" aria-label="More answer actions"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger></ControlTooltip><DropdownMenuContent align="start"><DropdownMenuItem disabled={!hasAnswerContent} onSelect={() => actions.exportAnswer(message.id)}><Download />Export as Markdown</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>
      {details.mode === 'code' && <time className="ml-1 text-[10px] text-muted-foreground" dateTime={message.createdAt.toISOString()}>{message.createdAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>}
    </div>}
  </MessagePrimitive.Root></MessageCitations.Provider>;
}

