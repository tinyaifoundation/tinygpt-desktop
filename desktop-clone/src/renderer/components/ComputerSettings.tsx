import { useEffect, useRef, useState } from 'react';
import type { AppSnapshot, DesktopBridge } from '../../shared/contracts';
import type { ComputerStatus } from '../../shared/computer';
import type { ApprovalRule, Settings } from '../../shared/config';
import { SettingRow, Switch } from './AppearanceSettings';
import { SettingsButton as Button } from './ui/settings-button';
import { SettingsSelect } from './ui/settings-select';

export function ComputerSettings({ snapshot, bridge, update }: { snapshot: AppSnapshot; bridge: DesktopBridge; update: (snapshot: AppSnapshot) => void }) {
  const [status, setStatus] = useState<ComputerStatus>();
  const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [error, setError] = useState('');
  const latest = useRef(snapshot); latest.current = snapshot;
  useEffect(() => {
    let active = true;
    const refresh = () => { void bridge.computerStatus().then(result => { if (active) { if (result.ok) setStatus(result.value); else setError(result.error); } }, () => { if (active) setError('Computer-use status could not be checked.'); }); };
    refresh(); const timer = setInterval(refresh, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [bridge]);
  async function act(operation: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The computer-use setting could not be changed.'); }
    finally { lock.current = false; setBusy(false); }
  }
  async function save(settings: Settings) {
    const result = await bridge.saveSettings(settings);
    if (!result.ok) throw Error(result.error);
    latest.current = result.value; update(result.value);
    const next = await bridge.computerStatus(); if (next.ok) setStatus(next.value);
  }
  const permissionsNeeded = status?.permissions && (!status.permissions.accessibility || !status.permissions.screenRecording);
  return <div className="space-y-6">
    <section className="settings-content-group"><h2>Desktop tools for Chat</h2><div className="settings-card">
      <SettingRow title="Computer tools in Chat" description="Let your assistant read accessible text and use labeled controls in an approved desktop window."><Switch label="Computer tools in Chat" disabled={busy} value={snapshot.settings.computer.enabled} change={enabled => void act(() => save({ ...latest.current.settings, computer: { enabled } }))} /></SettingRow>
      {(['desktop', 'desktopInteract'] as const).map(permission => <SettingRow key={permission} title={permission === 'desktop' ? 'Read desktop windows' : 'Control desktop windows'} description={permission === 'desktop' ? 'Window discovery and document reading have separate, scoped approvals.' : 'Control stays with the chosen window. Consequential actions need a separate confirmation.'}><SettingsSelect aria-label={permission === 'desktop' ? 'Read desktop windows' : 'Control desktop windows'} value={snapshot.settings.toolPermissions[permission]} disabled={busy} onChange={event => { const value = event.target.value as ApprovalRule; void act(() => save({ ...latest.current.settings, toolPermissions: { ...latest.current.settings.toolPermissions, [permission]: value } })); }}><option value="ask">Ask me first</option><option value="allow">Allow automatically</option><option value="deny">Never allow</option></SettingsSelect></SettingRow>)}
    </div></section>
    <section className="settings-content-group"><h2>Status and controls</h2><div className="settings-card">
      <SettingRow title="Local computer runtime" description={status?.message ?? 'Checking the bundled runtime…'}><span className="settings-value">{status?.available ? 'Bundled' : 'Checking'}</span></SettingRow>
      {permissionsNeeded && <SettingRow title="Mac permissions" description="Allow TinyGPT Voice in Accessibility and Screen Recording. You may need to quit and reopen the app after changing these grants."><Button disabled={busy || !status?.available} onClick={() => void act(async () => { const result = await bridge.computerPermissions(); if (!result.ok) throw Error(result.error); setStatus(result.value); })}>Open permissions</Button></SettingRow>}
      <SettingRow title="Stop computer use" description={`Stops desktop actions across chats. ${status?.stopShortcut ?? 'The Stop button in Chat also cancels the current reply.'}`}><Button disabled={busy} onClick={() => void act(async () => { const result = status?.paused ? await bridge.resumeComputer() : await bridge.stopComputer(); if (!result.ok) throw Error(result.error); setStatus(result.value); })}>{status?.paused ? 'Resume computer use' : 'Stop computer use'}</Button></SettingRow>
    </div></section>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
