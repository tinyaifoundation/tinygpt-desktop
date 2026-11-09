import type { BotConfiguration } from '../../shared/bot';
import { SettingsSelect } from './ui/settings-select';
import { SettingRow, Switch } from './AppearanceSettings';

export function BotAccessSettings({ value, change, busy = false, compact = false }: { value: BotConfiguration; change: (value: BotConfiguration) => void; busy?: boolean; compact?: boolean }) {
  return <div className={compact ? 'bot-setup-access' : 'settings-card'}>
    <SettingRow title="Remember useful details"><Switch label="Bot memory" value={value.memory} disabled={busy} change={memory => change({ ...value, memory })} /></SettingRow>
    <SettingRow title="Browse the web" description={compact ? undefined : 'Use TinyGPT’s browser and research tools with your shared permissions.'}><Switch label="Agent Browser" value={value.browser} disabled={busy} change={browser => change({ ...value, browser })} /></SettingRow>
    <SettingRow title="Take initiative" description="Let your bot notice developments and message you first while TinyGPT is open. Proactive checks run between 8 AM and 10 PM."><Switch label="Bot background tasks" value={value.background} disabled={busy} change={background => change({ ...value, background })} /></SettingRow>
    {!compact && value.background && <SettingRow title="Check in periodically"><SettingsSelect aria-label="Bot check-in frequency" value={value.heartbeat} disabled={busy} onChange={event => change({ ...value, heartbeat: event.target.value as BotConfiguration['heartbeat'] })}><option value="off">Off</option><option value="30m">Every 30 minutes</option><option value="1h">Every hour</option></SettingsSelect></SettingRow>}
  </div>;
}
