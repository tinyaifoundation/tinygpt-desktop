import { useEffect, useState } from 'react';
import { Play, Bell, Upload } from '../icons';
import type { AppSnapshot, DesktopBridge } from '../../shared/contracts';
import type { NotificationPreferences } from '../../shared/notifications';
import { useNotifications } from '../lib/notifications';
import { SettingRow, Switch } from './AppearanceSettings';
import { SettingsButton as Button } from './ui/settings-button';
import { SettingsSelect } from './ui/settings-select';

export function NotificationSettings({ snapshot, bridge, update }: { snapshot: AppSnapshot; bridge: DesktopBridge; update: (value: AppSnapshot) => void }) {
  const activity = useNotifications(bridge); const value = snapshot.settings.notifications;
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [volume, setVolume] = useState(Math.round(value.sound.volume * 100));
  useEffect(() => setVolume(Math.round(value.sound.volume * 100)), [value.sound.volume]);
  async function save(next: NotificationPreferences) {
    setBusy(true); setError(''); setNotice('');
    try { const result = await bridge.saveSettings({ ...snapshot.settings, notifications: next }); if (!result.ok) throw new Error(result.error); update(result.value); }
    catch (error) { setError(error instanceof Error ? error.message : 'Notification settings could not be saved.'); }
    finally { setBusy(false); }
  }
  const patch = (next: Partial<NotificationPreferences>) => void save({ ...value, ...next });
  async function test(kind: 'desktop' | 'sound' | 'choose') {
    setBusy(true); setError(''); setNotice('');
    try {
      if (kind === 'sound') { const result = await bridge.previewNotificationSound(); if (!result.ok) throw new Error(result.error); }
      else if (kind === 'desktop') { const result = await bridge.testDesktopNotification(); if (!result.ok) throw new Error(result.error); activity.setSnapshot(result.value); setNotice('Test alert sent. Your system controls whether it appears as a banner or in Notification Center.'); }
      else { const result = await bridge.chooseNotificationSound(); if (!result.ok) throw new Error(result.error); activity.setSnapshot(result.value); const settings = await bridge.snapshot(); if (settings.ok) update(settings.value); }
    } catch (error) { setError(error instanceof Error ? error.message : 'The notification could not be tested.'); }
    finally { setBusy(false); }
  }
  return <div className="notification-settings">
    <p className="settings-notice">Activity keeps a history of completed replies and requests for your attention. Choose how TinyGPT alerts you.</p>
    <section className="settings-content-group"><h2>Alerts</h2><div className="settings-card">
      <SettingRow title="Pause alerts" description="Silence desktop alerts and sounds. Activity keeps updating."><Switch label="Pause notification alerts" value={value.paused} change={paused => patch({ paused })} disabled={busy} /></SettingRow>
      <SettingRow title="Desktop notifications" description="Show an alert when work finishes or needs your attention."><Switch label="Desktop notifications" value={value.desktop} change={desktop => patch({ desktop })} disabled={busy || activity.snapshot?.desktopSupported === false} /></SettingRow>
      <SettingRow title="Only when you’re away" description="Keep alerts quiet while you’re viewing the relevant chat."><Switch label="Only notify when away" value={value.onlyWhenAway} change={onlyWhenAway => patch({ onlyWhenAway })} disabled={busy} /></SettingRow>
      <SettingRow title="Message previews" description="Include the chat title and a short preview in desktop alerts."><Switch label="Notification message previews" value={value.previews} change={previews => patch({ previews })} disabled={busy} /></SettingRow>
      <SettingRow title="Unread dots" description="Show blue dots on unread chats and the Activity button."><Switch label="Notification unread dots" value={value.badges} change={badges => patch({ badges })} disabled={busy} /></SettingRow>
    </div><div className="notification-settings-actions"><Button disabled={busy || activity.snapshot?.desktopSupported === false} onClick={() => void test('desktop')}><Bell />Test desktop notification</Button></div>
    {activity.snapshot?.desktopSupported === false && <p className="settings-notice">Desktop alerts aren’t available on this system. Activity and sounds are still available.</p>}</section>
    <section className="settings-content-group"><h2>Notify me about</h2><p className="settings-notice">These choices control desktop alerts and sounds. All events remain in Activity. Queued requests send a completion alert after the last request finishes.</p><div className="settings-card">
      {([['chat', 'Chat replies', 'When a Chat reply finishes.'], ['work', 'Work tasks', 'When a Work task finishes.'], ['bot', 'Bot replies and jobs', 'When your Bot has a reply or a background result.'], ['attention', 'Requests for attention', 'Tool approvals, browser handoffs, and required connections.'], ['errors', 'Problems and interruptions', 'When a reply cannot finish and needs review.']] as const).map(([key, title, description]) => <SettingRow key={key} title={title} description={description}><Switch label={`Notify about ${title}`} value={value.events[key]} change={enabled => patch({ events: { ...value.events, [key]: enabled } })} disabled={busy} /></SettingRow>)}
    </div></section>
    <section className="settings-content-group"><h2>Sound</h2><div className="settings-card">
      <SettingRow title="Play a sound" description="A short chime when an eligible alert arrives."><Switch label="Play notification sound" value={value.sound.enabled} change={enabled => patch({ sound: { ...value.sound, enabled } })} disabled={busy} /></SettingRow>
      <SettingRow title="Notification sound"><SettingsSelect aria-label="Notification sound" disabled={busy} value={value.sound.source} onChange={event => patch({ sound: { ...value.sound, source: event.target.value as 'default' | 'custom' } })}><option value="default">TinyGPT chime</option><option value="custom" disabled={!activity.snapshot?.customSoundName}>Custom sound{activity.snapshot?.customSoundName ? ` · ${activity.snapshot.customSoundName}` : ''}</option></SettingsSelect></SettingRow>
      <SettingRow title="Volume"><div className="appearance-range"><input aria-label="Notification volume" type="range" min="0" max="100" value={volume} disabled={busy} onChange={event => setVolume(Number(event.target.value))} onPointerUp={event => patch({ sound: { ...value.sound, volume: Number(event.currentTarget.value) / 100 } })} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) patch({ sound: { ...value.sound, volume: Number(event.currentTarget.value) / 100 } }); }} /><span>{volume}%</span></div></SettingRow>
    </div><div className="notification-settings-actions"><Button disabled={busy} onClick={() => void test('sound')}><Play />Preview sound</Button><Button disabled={busy} onClick={() => void test('choose')}><Upload />Choose custom sound</Button></div></section>
    <section className="settings-content-group"><h2>Quiet hours</h2><div className="settings-card">
      <SettingRow title="Use quiet hours" description="Pause desktop alerts and sounds during these hours, using your local time."><Switch label="Notification quiet hours" value={value.quietHours.enabled} change={enabled => patch({ quietHours: { ...value.quietHours, enabled } })} disabled={busy} /></SettingRow>
      {value.quietHours.enabled && <SettingRow title="Quiet from"><div className="notification-time-range"><input aria-label="Quiet hours start" type="time" value={value.quietHours.start} disabled={busy} onChange={event => { if (event.target.value) patch({ quietHours: { ...value.quietHours, start: event.target.value } }); }} /><span>to</span><input aria-label="Quiet hours end" type="time" value={value.quietHours.end} disabled={busy} onChange={event => { if (event.target.value) patch({ quietHours: { ...value.quietHours, end: event.target.value } }); }} /></div></SettingRow>}
    </div></section>
    {notice && <p role="status" className="settings-notice">{notice}</p>}{(error || activity.error || activity.snapshot?.deliveryError) && <p role="alert" className="settings-notice text-destructive">{error || activity.error || activity.snapshot?.deliveryError}</p>}
  </div>;
}
