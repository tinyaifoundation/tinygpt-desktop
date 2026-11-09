import { Fragment } from 'react';
import { MoreHorizontal, Pencil, Settings, Square, Trash2, Pause, Play } from '../icons';
import { Button } from './ui/button';
import { ControlTooltip } from './ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from './ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from './ui/context-menu';
import { RobotAvatar } from './RobotAvatar';
import type { BotDesign } from '../lib/bot';
import type { BotAvatarAction } from '../lib/bot-avatar';

export function SidebarBot({ design, active, busy, running, action, configured, unreadCount, select, settings, customize, clear, stop, snoozed, snooze }: {
  snoozed?: boolean; snooze?: () => void;
  design: BotDesign; active: boolean; busy: boolean; running: boolean; action: BotAvatarAction; configured: boolean; unreadCount: number;
  select: () => void; settings: () => void; customize: () => void; clear: () => void; stop: () => void;
}) {
  const actions = [
    ...(configured && snooze ? [{ key: 'snooze', label: snoozed ? 'Wake bot' : 'Snooze bot', icon: snoozed ? Play : Pause, select: snooze, disabled: busy }] : []),
    { key: 'settings', label: 'Settings', icon: Settings, select: settings, disabled: busy },
    { key: 'customize', label: 'Customize', icon: Pencil, select: customize, disabled: busy },
    ...(running ? [{ key: 'stop', label: 'Stop response', icon: Square, select: stop, disabled: busy }] : []),
    { key: 'clear', label: 'Clear conversation', icon: Trash2, select: clear, disabled: busy || !configured || running },
  ];
  return <ContextMenu modal={false}><ContextMenuTrigger asChild><div className={`sidebar-bot-row ${active ? 'is-active' : ''}`}>
    <ControlTooltip label={snoozed ? design.name + ' · Sleeping' : design.name}><Button variant="ghost" className="sidebar-entry sidebar-nav-action sidebar-bot-button" aria-label="Your bot" aria-pressed={active} disabled={busy} onClick={select}>
      <RobotAvatar design={design} size={17} className="sidebar-bot-avatar" action={action} /><span className="sidebar-action-label">{design.name}</span>{unreadCount > 0 && <span className="sidebar-bot-notification" role="status" aria-label={`${unreadCount} unread bot notification${unreadCount === 1 ? '' : 's'}`}><i aria-hidden="true" /><span aria-hidden="true">{unreadCount > 99 ? '99+' : unreadCount}</span></span>}
    </Button></ControlTooltip>
    <div className="sidebar-bot-controls"><DropdownMenu modal={false}><DropdownMenuTrigger asChild><button type="button" aria-label={`More for ${design.name}`} disabled={busy}><MoreHorizontal /></button></DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="conversation-menu" aria-label={`${design.name} controls`}>
        {actions.map(item => <Fragment key={item.key}>{item.key === 'clear' && <DropdownMenuSeparator />}<DropdownMenuItem disabled={item.disabled} onSelect={item.select}><item.icon />{item.label}</DropdownMenuItem></Fragment>)}
      </DropdownMenuContent>
    </DropdownMenu></div>
  </div></ContextMenuTrigger><ContextMenuContent className="conversation-menu" aria-label={`${design.name} controls`}>
    {actions.map(item => <Fragment key={item.key}>{item.key === 'clear' && <ContextMenuSeparator />}<ContextMenuItem disabled={item.disabled} onSelect={item.select}><item.icon />{item.label}</ContextMenuItem></Fragment>)}
  </ContextMenuContent></ContextMenu>;
}
