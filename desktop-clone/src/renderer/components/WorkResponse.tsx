import { WorkOutcomeCard } from './WorkOutcomeCard';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, CornerDownRight, Lightbulb } from '../icons';
import type { ContextActivity, MessageStatus, WorkActivity } from '../../shared/chat';
import type { ToolActivity } from '../../shared/tools';
import { workBlocks, workToolSummary, type WorkBlock } from '../../core/work-activity';
import { formatWorkDuration } from '../../core/work-duration';
import { codeToolLabel } from '../../core/code-progress';
import { toolProgressText } from '../../shared/tool-display';
import { ScrollArea } from './ui/scroll-area';
import { MarkdownBody } from './AnswerMarkdown';
import { ContextOptimization, Reasoning, Shimmer, ToolRow } from './ConversationMessages';
import { useToolIcon } from '../tool-icons';

function WorkTools({ chain, running, thinking }: { chain: Extract<WorkBlock, { kind: 'tools' }>; running: boolean; thinking: boolean }) {
  const [open, setOpen] = useState(false);
  const { tools, steps } = chain;
  const current = running ? [...tools].reverse().find(tool => ['pending', 'running'].includes(tool.status)) : undefined;
  const representative = current ?? tools[0];
  const RepresentativeIcon = useToolIcon(representative?.name ?? 'work_plan');
  const Icon = representative ? RepresentativeIcon : Lightbulb;
  const label = current ? codeToolLabel(current, true) : workToolSummary(tools) || (thinking ? 'Thinking…' : 'Thought');
  return <details className="work-tool-chain" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}><summary><Icon aria-hidden="true" strokeWidth={1.25} className="size-4 shrink-0 opacity-60" /><Shimmer active={!open && (!!current || thinking)}>{label}</Shimmer><ChevronDown aria-hidden="true" className="work-tool-caret size-3.5" /></summary>{open && <ScrollArea className="work-tool-results" viewportClassName="work-tool-viewport"><ol aria-label="Work steps" className="space-y-2.5">{steps.map(step => step.kind === 'tool' ? <ToolRow key={step.id} tool={step.tool} running={running} /> : <li key={step.id}><Reasoning nested text={step.text} status={{ type: thinking && step === steps.at(-1) ? 'running' : 'complete' }} /></li>)}</ol></ScrollArea>}</details>;
}

function CodingAgent({ block, running, thinking }: { block: Extract<WorkBlock, { kind: 'agent' }>; running: boolean; thinking: boolean }) {
  const active = running && ['pending', 'running'].includes(block.tool.status);
  const [open, setOpen] = useState(active);
  const previous = useRef(active);
  const Icon = useToolIcon('code_delegate');
  useLayoutEffect(() => {
    if (active !== previous.current) setOpen(active);
    previous.current = active;
  }, [active]);
  const tools = block.blocks.flatMap(child => child.kind === 'tools' ? child.tools : []);
  const current = active ? [...tools].reverse().find(tool => ['pending', 'running'].includes(tool.status)) : undefined;
  const failed = ['error', 'denied', 'cancelled', 'interrupted'].includes(block.tool.status);
  const updated = tools.some(tool => tool.status === 'success' && ['code_edit', 'code_write', 'code_apply_patch'].includes(tool.name));
  const detail = active ? current ? codeToolLabel(current, true) : thinking ? 'Thinking…' : 'Working…'
    : failed ? 'Needs attention' : updated ? 'Updated files' : tools.some(tool => tool.name === 'code_devtools' && tool.status === 'success') ? 'Checked the browser' : '';
  return <details data-slot="coding-agent" className="work-tool-chain work-coding-agent" open={open} onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
    <summary><Icon aria-hidden="true" strokeWidth={1.25} className="size-4 shrink-0 opacity-60" /><span>Coding agent</span>{detail && <><span aria-hidden="true">·</span><Shimmer active={active && !open}>{detail}</Shimmer></>}<ChevronDown aria-hidden="true" className="work-tool-caret size-3.5" /></summary>
    {open && <div className="work-coding-agent-activity"><ActivityBlocks blocks={block.blocks} running={active} thinking={active && thinking} /></div>}
  </details>;
}

function ActivityBlocks({ blocks, running, thinking }: { blocks: WorkBlock[]; running: boolean; thinking: boolean }) {
  return <>{blocks.map(block => block.kind === 'prose'
    ? <div key={block.id} data-slot="work-prose"><MarkdownBody value={toolProgressText(block.text)} /></div>
    : block.kind === 'context' ? <ContextOptimization key={block.id} activity={block.activity} />
    : block.kind === 'steering' ? <div key={block.id} data-slot="work-steering" className="flex gap-2 rounded-xl bg-muted px-3 py-2 text-sm"><CornerDownRight aria-hidden="true" className="mt-1 size-4 shrink-0 text-muted-foreground" /><div><span className="text-xs text-muted-foreground">You steered the work</span><p className="whitespace-pre-wrap">{block.text}</p></div></div>
    : block.kind === 'agent' ? <CodingAgent key={block.id} block={block} running={running} thinking={thinking && block === blocks.at(-1)} />
    : <WorkTools key={block.id} chain={block} running={running} thinking={running && thinking && block === blocks.at(-1)} />)}</>;
}

/** Presents recorded activity; does not control harness execution. */
export function WorkResponse({ task, activity, contexts = [], tools, reasoning, reasoningRunning = false, prose, running, answerStarted = false, status, duration, createdAt, children }: {
  task?: import('../../shared/work').WorkTask;
  activity: readonly WorkActivity[]; tools: ToolActivity[]; reasoning: string; prose?: string;
  contexts?: readonly ContextActivity[];
  running: boolean; answerStarted?: boolean; reasoningRunning?: boolean; status: MessageStatus; duration?: number | null; createdAt: number; children: ReactNode;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(status !== 'complete' && !answerStarted);
  const previous = useRef({ running, status, answerStarted });
  const clock = useRef({ ms: duration ?? Math.max(0, Date.now() - createdAt), at: Date.now(), saved: duration });
  if (clock.current.saved !== duration) clock.current = { ms: duration ?? 0, at: Date.now(), saved: duration };
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  useLayoutEffect(() => {
    if (running && !answerStarted && (!previous.current.running || previous.current.answerStarted)) setOpen(true);
    if (answerStarted && !previous.current.answerStarted || status === 'complete' && previous.current.status !== 'complete' && !previous.current.answerStarted) {
      // Anchor this response when its activity disappears, without moving a
      // reader who is looking at a different turn.
      const viewport = root.current?.closest<HTMLElement>('.thread-viewport');
      const box = root.current?.getBoundingClientRect();
      const bounds = viewport?.getBoundingClientRect();
      if (box && bounds && box.top < bounds.bottom && box.bottom > bounds.top) root.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
      setOpen(false);
    }
    previous.current = { running, status, answerStarted };
  }, [running, status, answerStarted]);
  const fallback = useMemo<WorkActivity[]>(() => activity.length ? [...activity] : [
    ...(prose?.trim() ? [{ id: 'legacy-prose', runId: '', kind: 'prose' as const, text: prose }] : []),
    ...(reasoning.trim() ? [{ id: 'legacy-reasoning', runId: '', kind: 'reasoning' as const, text: reasoning }] : []),
  ], [activity, reasoning, prose]);
  const activeRunId = running ? task?.runId ?? activity.at(-1)?.runId : undefined;
  const blocks = useMemo(() => workBlocks(fallback, tools, contexts, activeRunId), [fallback, tools, contexts, activeRunId]);
  const elapsed = running ? clock.current.ms + Math.max(0, now - clock.current.at) : duration;
  const label = task?.status === 'awaiting-input' ? 'Waiting for your answer' : running ? `Working for ${formatWorkDuration(elapsed ?? 0)}` : elapsed == null ? status === 'complete' ? 'Worked' : 'Work interrupted' : `Worked for ${formatWorkDuration(elapsed)}`;
  return <div ref={root} data-slot="work-response" className="work-response">
    <button type="button" className="work-response-heading" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><span data-slot="work-summary" role={running ? 'status' : undefined}>{label}</span><ChevronDown aria-hidden="true" className={`size-3.5 ${open ? 'rotate-180' : ''}`} /></button>
    <div className="work-response-divider" />
    <div id={id} className="work-response-history" hidden={!open}>
      {open && <div className="work-response-activity"><ActivityBlocks blocks={blocks} running={running} thinking={running && reasoningRunning} /></div>}
    </div>
    {task && !['error', 'cancelled', 'interrupted'].includes(status) && <WorkOutcomeCard task={task} />}
    {children}
  </div>;
}
