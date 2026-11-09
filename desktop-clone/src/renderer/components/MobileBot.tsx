import type { RemoteBotState } from '../../shared/bot-design';
import { Moon, Sun, Clock } from '../icons';
import browserArtwork from '../assets/bot-browser.png';
import { RobotAvatar } from './RobotAvatar';
import { Dialog } from './ui/dialog';
import { Button } from './ui/button';

export function mobileBotStatus(bot: RemoteBotState, working: boolean) {
  return bot.snoozed ? 'Sleeping' : working ? 'Working' : bot.phase === 'preparing' ? 'Getting ready' : bot.phase === 'error' ? 'Needs attention' : 'Here for you';
}
export function MobileBotAvatar({ bot, working, size = 30 }: { bot: RemoteBotState; working: boolean; size?: number }) {
  return <RobotAvatar design={bot.design} size={size} action={bot.snoozed ? 'snooze' : working ? 'waiting' : 'idle'} />;
}
export function MobileBotInfo({ bot, working, open, close, busy, online, snooze }: { bot: RemoteBotState; working: boolean; open: boolean; close: () => void; busy: boolean; online: boolean; snooze: (value: boolean) => void }) {
  return <Dialog open={open} change={value => { if (!value) close(); }} title={bot.name} titleHidden className="mobile-action-sheet mobile-bot-sheet">
    <div className="mobile-bot-profile"><MobileBotAvatar bot={bot} working={working} size={76} /><h2>{bot.name}</h2><p role="status">{mobileBotStatus(bot, working)}</p></div>
    <Button variant="outline" className="mobile-bot-snooze" disabled={busy || !online} onClick={() => snooze(!bot.snoozed)}>{bot.snoozed ? <Sun /> : <Moon />}{bot.snoozed ? 'Wake up' : 'Snooze'}</Button>
    <div className="mobile-bot-browser"><img src={browserArtwork} alt="" /><span>{bot.name}’s browser<small>{bot.snoozed ? 'Sleeping' : bot.browser ? 'Ready on your computer' : 'Off'}</small></span></div>
    {!!bot.watches.length && <section className="mobile-bot-watches"><h3>Keeping an eye on</h3>{bot.watches.map(watch => <div key={watch.id}><Clock /><span>{watch.title}</span><small>{bot.snoozed || !watch.enabled ? 'Paused' : watch.nextRunAt ? new Date(watch.nextRunAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Waiting'}</small></div>)}</section>}
  </Dialog>;
}
