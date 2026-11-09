import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, MessageCircle, Settings, MoreHorizontal, Clock } from '../icons';
import browserArtwork from '../assets/bot-browser.png';
import type { DesktopBridge } from '../../shared/contracts';
import type { BotJob, BotSnapshot } from '../../shared/bot';
import type { Conversation } from '../../shared/chat';
import type { BotDesign } from '../lib/bot';
import { RobotAvatar } from './RobotAvatar';
import type { BotAvatarAction } from '../lib/bot-avatar';
import { useToolIcon } from '../tool-icons';
import { botActivity, type BotActivity } from '../../core/bot-activity';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuLabel, DropdownMenuSeparator } from './ui/dropdown-menu';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';

/** This card describes the Bot's own resources, never unrelated chats/accounts. */
export function BotCompanionPanel({ bot, status, conversation, bridge, identity, action, activity: avatarActivity, browserPreview, activeBrowser, edit, message, openBrowser, openSource, jump }: {
  bot: BotDesign; status: BotSnapshot; conversation: Conversation; bridge: DesktopBridge;
  identity: ReactNode; browserPreview?: ReactNode; activeBrowser: boolean;
  action: BotAvatarAction; activity?: 'working' | 'reviewing' | 'writing';
  edit: () => void; message: () => void; openBrowser: () => void; openSource: (id: string) => void; jump: (id: string) => void;
}) {
  const [jobs, setJobs] = useState<BotJob[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string>();
  const [sleepBusy, setSleepBusy] = useState(false);
  async function toggleSnooze() {
    setSleepBusy(true); setError('');
    try { const result = await bridge.setBotSnoozed(!status.snoozed); if (!result.ok) setError(result.error); }
    catch { setError('Your bot could not change its sleep status.'); }
    finally { setSleepBusy(false); }
  }
  useEffect(() => {
    let disposed = false;
    async function refresh() {
      try { const result = await bridge.botJobs(); if (!disposed) { if (result.ok) { setJobs(result.value); setError(''); } else setError(result.error); } }
      catch { if (!disposed) setError('Watches could not be loaded.'); }
    }
    void refresh(); const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 30000);
    const unsubscribe = bridge.onScheduledUpdate(() => { void refresh(); });
    return () => { disposed = true; clearInterval(timer); unsubscribe(); };
  }, [bridge, conversation.id, conversation.updatedAt]);
  async function changeJob(job: BotJob, action: 'pause' | 'resume' | 'run' | 'remove' = job.enabled ? 'pause' : 'resume') {
    setBusy(job.id); setError('');
    try { const result = await bridge.changeBotJob({ id: job.id, action }); if (result.ok) setJobs(result.value); else setError(result.error); }
    catch { setError('This watch could not be updated.'); }
    finally { setBusy(undefined); }
  }
  const outputs = conversation.sources.filter(source => source.conversationId === conversation.id && !!source.messageId && ['generated-image', 'project-file'].includes(source.kind)).slice(-4).reverse();
  return <aside className="bot-companion-panel" aria-label="Your bot">
    <div className="bot-companion-identity"><button className="bot-companion-avatar" type="button" aria-label={'Edit ' + bot.name} onClick={edit}><RobotAvatar design={bot} size={56} interactive action={action} activity={avatarActivity} /></button><div><button className="bot-companion-name" type="button" onClick={edit}>{bot.name}</button><div className="bot-companion-status" role="status">{identity}</div></div></div>
    <div className="bot-companion-actions"><button type="button" onClick={message} disabled={status.snoozed}><MessageCircle />Message</button><button type="button" onClick={edit}><Settings />Edit bot</button><button type="button" className="bot-snooze-control" aria-label={(status.snoozed ? 'Wake ' : 'Snooze ') + bot.name} disabled={sleepBusy} onClick={() => void toggleSnooze()}>{status.snoozed ? 'Wake' : 'Snooze'}</button></div>
    <section className="bot-companion-browser" aria-label="Bot browser">
      <button type="button" className="bot-browser-link" onClick={openBrowser}><img className="bot-browser-artwork" src={browserArtwork} alt="" draggable={false} /><span><strong>{bot.name}’s browser</strong><small>{status.snoozed ? 'Sleeping' : !status.configuration?.browser ? 'Off' : activeBrowser ? 'Browsing' : 'Ready'}</small></span></button>
      {browserPreview}
    </section>
    <section><h2>Keeping an eye on</h2>{jobs.length ? <ul className="bot-companion-watches">{jobs.map(job => {
      const timing = status.snoozed ? 'Waiting for you to wake me' : !status.configuration?.background ? 'Initiative is off' : !job.enabled ? 'Paused' : job.nextRunAt ? 'Next check ' + new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(job.nextRunAt) : 'No check scheduled';
      return <Tooltip key={job.id}><TooltipTrigger asChild><li className="bot-companion-row" tabIndex={0}>
        <Clock className="bot-watch-icon" aria-hidden="true" />
        <strong className="bot-watch-title">{job.name}</strong>
        {(job.running || !job.enabled) && <span className="bot-watch-state">{job.running ? 'Checking…' : 'Paused'}</span>}
        <BotRowMenu label={'More for watch ' + job.name}>
          <DropdownMenuLabel className="bot-watch-timing">{timing}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!!busy} onSelect={() => void changeJob(job)}>{job.enabled ? 'Pause' : 'Resume'}</DropdownMenuItem>
          <DropdownMenuItem disabled={!!busy || !!job.running || !!status.snoozed} onSelect={() => void changeJob(job, 'run')}>Check now</DropdownMenuItem>
          <DropdownMenuItem disabled={!!busy} onSelect={() => void changeJob(job, 'remove')}>Remove</DropdownMenuItem>
        </BotRowMenu>
      </li></TooltipTrigger><TooltipContent side="left" className="max-w-64"><div>{job.name}</div><div className="opacity-75">{timing}</div></TooltipContent></Tooltip>;
    })}</ul> : <p className="bot-companion-hint">{status.configuration?.background ? 'Ask me to keep an eye on something.' : 'Turn on initiative in Edit bot to enable watches.'}</p>}</section>
    <BotRecentActivity conversation={conversation} openBrowser={openBrowser} jump={jump} />
    {!!outputs.length && <section><h2>Saved outputs</h2><ul className="bot-companion-activity">{outputs.map(source => <li key={source.id}><button type="button" onClick={() => openSource(source.id)}><span>{source.title}</span><ArrowUpRight /></button></li>)}</ul></section>}
    {error && <p role="alert" className="bot-companion-error">{error}</p>}
  </aside>;
}

function BotRowMenu({ label, children }: { label: string; children: ReactNode }) {
  return <DropdownMenu modal={false}><DropdownMenuTrigger asChild><button className="bot-row-menu" type="button" aria-label={label}><MoreHorizontal /></button></DropdownMenuTrigger><DropdownMenuContent align="end" className="conversation-menu">{children}</DropdownMenuContent></DropdownMenu>;
}

function BotRecentActivity({ conversation, openBrowser, jump }: { conversation: Conversation; openBrowser: () => void; jump: (id: string) => void }) {
  const activity = botActivity(conversation);
  const list = useRef<HTMLUListElement>(null);
  const positions = useRef(new Map<string, number>());
  const signature = activity.map(tool => tool.id).join(':');
  useLayoutEffect(() => {
    const node = list.current; if (!node) { positions.current.clear(); return; }
    const top = node.getBoundingClientRect().top;
    const next = new Map<string, number>();
    const animations: Animation[] = [];
    const reduced = document.documentElement.dataset.motion === 'reduce' || document.documentElement.dataset.motion !== 'full' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const row of node.querySelectorAll<HTMLElement>('[data-activity-id]')) {
      const id = row.dataset.activityId!, y = row.getBoundingClientRect().top - top;
      next.set(id, y);
      if (positions.current.size && !reduced) {
        const previous = positions.current.get(id);
        const offset = previous === undefined ? -38 : previous - y;
        if (offset) animations.push(row.animate([{ transform: 'translateY(' + offset + 'px)', opacity: previous === undefined ? 0 : 1 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 240, easing: 'cubic-bezier(.2,.75,.25,1)' }));
      }
    }
    positions.current = next;
    return () => animations.forEach(animation => animation.cancel());
  }, [signature, conversation.id]);
  if (!activity.length) return null;
  return <section aria-label="Recent bot activity"><h2>Recent activity</h2><ul ref={list} className="bot-companion-activity bot-recent-activity" aria-live="polite" aria-relevant="additions">{activity.map(item => {
    return <BotActivityChip key={item.id} item={item} openMessage={item.messageId ? () => jump(item.messageId!) : undefined} openBrowser={openBrowser} />;
  })}</ul></section>;
}

function BotActivityChip({ item, openMessage, openBrowser }: { item: BotActivity; openMessage?: () => void; openBrowser: () => void }) {
  const ToolIcon = useToolIcon(item.tool?.name ?? 'bot_activity');
  const Icon = item.tool ? ToolIcon : MessageCircle;
  return <Tooltip><TooltipTrigger asChild><li className="bot-companion-row" data-activity-id={item.id}><button type="button" disabled={!openMessage} onClick={openMessage}><Icon aria-hidden="true" className="bot-activity-tool-icon" /><span>{item.title}</span></button><BotRowMenu label={'More for activity ' + item.title}><DropdownMenuItem disabled={!openMessage} onSelect={openMessage}>Open message</DropdownMenuItem>{item.browser && <DropdownMenuItem onSelect={openBrowser}>Open browser</DropdownMenuItem>}</BotRowMenu></li></TooltipTrigger><TooltipContent side="left" className="max-w-64"><div>{item.title}</div><div className="opacity-75">{item.detail}</div></TooltipContent></Tooltip>;
}
