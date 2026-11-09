import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { subscribeChatUpdates } from '../lib/chat-updates';
import type { DesktopBridge } from '../../shared/contracts';
import type { ProfileUsage as Usage } from '../../shared/chat';
import { ControlTooltip, TooltipProvider } from './ui/tooltip';
import { useToolIcon, useToolLabel } from '../tool-icons';
import type { ToolName } from '../../shared/tools';

function UsageTool({ tool }: { tool: Usage['topTools'][number] }) {
  const Icon = useToolIcon(tool.name as ToolName);
  const label = useToolLabel(tool.name);
  return <div><span className="usage-tool-label"><Icon aria-hidden="true" /><span>{label}</span></span><strong>{tool.count.toLocaleString()}</strong></div>;
}

function dayKey(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function dateLabel(date: Date) { return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); }
function countLabel(value: number, noun: string) { return `${value.toLocaleString()} ${noun}${value === 1 ? '' : 's'}`; }
function compactTokens(value: number | null) {
  if (value === null) return '—';
  if (value >= 1_000_000) return `${Math.floor(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.floor(value / 1_000)}K`;
  return value.toLocaleString();
}

function TokenActivity({ daily }: { daily: Usage['daily'] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const start = new Date(today); start.setDate(start.getDate() - 364);
  const first = new Date(start); first.setDate(first.getDate() - first.getDay());
  const last = new Date(today); last.setDate(last.getDate() + 6 - last.getDay());
  const days: { date: Date; key: string; inRange: boolean }[] = [];
  for (const cursor = new Date(first); cursor <= last; cursor.setDate(cursor.getDate() + 1)) days.push({ date: new Date(cursor), key: dayKey(cursor), inRange: cursor >= start && cursor <= today });
  const weeks = days.length / 7;
  const months: { name: string; week: number }[] = [];
  days.forEach((day, index) => {
    if (!day.inRange || day.date.getDate() !== 1 && day.key !== dayKey(start)) return;
    if (day.key === dayKey(start) && day.date.getDate() > 14) return;
    const week = Math.floor(index / 7);
    if (months.at(-1)?.week !== week) months.push({ name: day.date.toLocaleDateString(undefined, { month: 'short' }), week });
  });
  const byDay = new Map(daily.map(day => [day.day, day]));
  const peak = Math.max(1, ...days.filter(day => day.inRange).map(day => byDay.get(day.key)?.tokens ?? 0));
  const selectedDay = days.find(day => day.inRange && day.key === selected) ?? days.find(day => day.key === dayKey(today))!;
  const activity = byDay.get(selectedDay.key);
  const tokens = activity ? activity.tokens : 0;
  function move(event: KeyboardEvent<HTMLButtonElement>, date: Date) {
    const delta = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const next = new Date(date); next.setDate(next.getDate() + delta);
    const button = grid.current?.querySelector<HTMLButtonElement>(`[data-day="${dayKey(next)}"]`);
    if (button) { setSelected(dayKey(next)); button.focus(); }
  }
  return <div className="usage-activity">
    <div className="profile-section-heading"><h2>Token activity</h2><span>Last 12 months</span></div>
    <TooltipProvider><div className="activity-scroll"><div className="activity-calendar">
      <div className="activity-months" style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }}>{months.map(month => <span key={`${month.week}-${month.name}`} style={{ gridColumn: month.week + 1 }}>{month.name}</span>)}</div>
      <div className="activity-calendar-body"><div className="activity-weekdays" aria-hidden="true">{['', 'Mon', '', 'Wed', '', 'Fri', ''].map((day, index) => <span key={index}>{day}</span>)}</div>
      <div className="activity-heatmap" ref={grid} style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }} aria-label="Daily token activity over the past year">
        {days.map(day => {
          if (!day.inRange) return <i key={day.key} className="activity-outside" aria-hidden="true" />;
          const value = byDay.get(day.key);
          const count = value ? value.tokens : 0;
          const level = count ? Math.min(4, Math.max(1, Math.ceil(count / peak * 4))) : 0;
          const label = `${dateLabel(day.date)}: ${count === null ? 'Token usage unavailable' : countLabel(count, 'token')}`;
          return <ControlTooltip key={day.key} label={label}><button type="button" aria-label={label} aria-pressed={selectedDay.key === day.key} data-day={day.key} data-level={level} onClick={() => setSelected(day.key)} onKeyDown={event => move(event, day.date)} /></ControlTooltip>;
        })}
      </div></div>
    </div></div></TooltipProvider>
    <div className="activity-calendar-footer"><div className="activity-detail" aria-live="polite"><strong>{dateLabel(selectedDay.date)}</strong><span>{tokens === null ? '— tokens' : countLabel(tokens, 'token')} · {countLabel(activity?.responses ?? 0, 'response')} · {countLabel(activity?.tools ?? 0, 'tool')}</span></div><div className="heatmap-legend" aria-label="Token usage from less to more"><span>Less</span>{[0, 1, 2, 3, 4].map(level => <i key={level} data-level={level} />)}<span>More</span></div></div>
  </div>;
}

export function ProfileUsage({ bridge }: { bridge: DesktopBridge }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const refresh = () => { void bridge.profileUsage().then(result => {
      if (!live) return;
      if (result.ok) { setUsage(result.value); setError(''); } else setError(result.error);
    }, () => { if (live) setError('Usage could not be loaded.'); }); };
    refresh();
    const unsubscribe = subscribeChatUpdates(bridge, update => { if (!update.library.activeRuns.some(run => run.conversationId === update.conversation.id)) refresh(); });
    return () => { live = false; unsubscribe(); };
  }, [bridge]);
  if (!usage) return <p className="settings-notice" role={error ? 'alert' : 'status'}>{error || 'Loading activity…'}</p>;
  const metrics = [
    ['Lifetime tokens', compactTokens(usage.totalTokens)], ['Peak tokens', compactTokens(usage.peakTokens)],
    ['Longest chat', `${usage.longestChat} ${usage.longestChat === 1 ? 'turn' : 'turns'}`],
    ['Current streak', `${usage.currentStreak} ${usage.currentStreak === 1 ? 'day' : 'days'}`],
    ['Longest streak', `${usage.longestStreak} ${usage.longestStreak === 1 ? 'day' : 'days'}`],
  ];
  return <section className="profile-usage" aria-label="Usage and activity">
    <div className="usage-metrics">{metrics.map(([label, value]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>
    <TokenActivity daily={usage.daily} />
    <div className="profile-insights"><div><h2>Activity insights</h2><table><tbody>{[['Total chats', usage.conversationCount], ['Assistant responses', usage.responseCount], ['Tools used', usage.toolCalls]].map(([label, value]) => <tr key={label}><th scope="row">{label}</th><td>{value.toLocaleString()}</td></tr>)}</tbody></table></div>
      {usage.topTools.length > 0 && <div className="usage-tools"><h2>Most used tools</h2>{usage.topTools.map(tool => <UsageTool key={tool.name} tool={tool} />)}</div>}
    </div>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
