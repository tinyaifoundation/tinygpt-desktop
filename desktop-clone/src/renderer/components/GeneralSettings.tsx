import { useRef, useState } from 'react';
import type { AppSnapshot, DesktopBridge } from '../../shared/contracts';
import type { ApprovalRule, ToolPermissions } from '../../shared/config';
import { SettingRow } from './AppearanceSettings';
import { SettingsSelect } from './ui/settings-select';
import { AppUpdate } from './AppUpdate';

export const approvalLabels: Record<keyof ToolPermissions, string> = {
  read: 'Read files and saved sources', write: 'Change files', execute: 'Run commands',
  browser: 'Search and read pages', interact: 'Interact with websites', desktop: 'Read desktop windows',
  desktopInteract: 'Control desktop windows', send: 'Send messages', purchase: 'Make purchases',
};

export function ToolApprovalSettings({ snapshot, bridge, update, operations = Object.keys(approvalLabels) as (keyof ToolPermissions)[] }: {
  snapshot: AppSnapshot; bridge: DesktopBridge; update: (next: AppSnapshot) => void; operations?: (keyof ToolPermissions)[];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const latest = useRef(snapshot); latest.current = snapshot;
  const lock = useRef(false);
  async function change(operation: keyof ToolPermissions, value: ApprovalRule) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const settings = latest.current.settings;
      const result = await bridge.saveSettings({ ...settings, toolPermissions: { ...settings.toolPermissions, [operation]: value } });
      if (!result.ok) throw new Error(result.error);
      latest.current = result.value; update(result.value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Tool approvals could not be updated.'); }
    finally { lock.current = false; setBusy(false); }
  }
  return <><div className="settings-card">{operations.map(operation => <SettingRow key={operation} title={approvalLabels[operation]}><SettingsSelect aria-label={approvalLabels[operation]} disabled={busy} value={snapshot.settings.toolPermissions[operation]} onChange={event => void change(operation, event.target.value as ApprovalRule)}><option value="ask">Ask me first</option><option value="allow">Allow automatically</option><option value="deny">Never allow</option></SettingsSelect></SettingRow>)}</div>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</>;
}

export function GeneralSettings(props: { snapshot: AppSnapshot; bridge: DesktopBridge; update: (next: AppSnapshot) => void }) {
  const { snapshot, bridge } = props;
  const [welcomeBusy, setWelcomeBusy] = useState(false);
  const [welcomeError, setWelcomeError] = useState('');
  return <div className="general-settings-page">
    <section className="settings-content-group"><h2>Tool approvals</h2><ToolApprovalSettings {...props} /></section>
    <section className="settings-content-group"><h2>TinyGPT</h2><div className="settings-card">
      <SettingRow title="Welcome to TinyGPT" description="Revisit models, your optional profile name and memories, voice, and your first conversation."><button type="button" className="settings-value underline underline-offset-4" disabled={welcomeBusy} onClick={() => {
        setWelcomeBusy(true); setWelcomeError('');
        void bridge.saveOnboarding({ version: 1, step: 0, status: 'in-progress' }).then(result => { if (result.ok) props.update(result.value); else setWelcomeError(result.error); }, () => setWelcomeError('The welcome experience could not be opened.')).finally(() => setWelcomeBusy(false));
      }}>Open welcome</button></SettingRow>
      <SettingRow title="Version"><span className="settings-value">{snapshot.version}</span></SettingRow>
      <SettingRow title="Updates"><AppUpdate bridge={bridge} settings /></SettingRow>
      <SettingRow title="Language"><span className="settings-value">English</span></SettingRow>
      <SettingRow title="Storage" description="Conversations, Projects, and preferences are saved on this computer."><span className="settings-value">Local</span></SettingRow>
      <SettingRow title="Icons" description="Solar icons by 480 Design · CC BY 4.0"><button type="button" className="settings-value underline underline-offset-4" onClick={() => void bridge.openBrowserLink('https://solar-icons.dev/')}>Solar Icons</button></SettingRow>
    </div></section>
    {welcomeError && <p role="alert" className="text-sm text-destructive">{welcomeError}</p>}
  </div>;
}
