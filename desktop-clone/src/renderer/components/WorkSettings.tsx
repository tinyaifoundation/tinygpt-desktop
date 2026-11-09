import { useRef, useState } from 'react';
import type { AppSnapshot, DesktopBridge } from '../../shared/contracts';
import { effortLabel, effortLevels, type Effort } from '../../shared/effort';
import type { Appearance } from '../lib/appearance';
import { SettingRow } from './AppearanceSettings';
import { ToolApprovalSettings } from './GeneralSettings';
import { SettingsSelect } from './ui/settings-select';

export function WorkSettings({ snapshot, bridge, update, appearance, changeAppearance }: {
  snapshot: AppSnapshot; bridge: DesktopBridge; update: (next: AppSnapshot) => void;
  appearance: Appearance; changeAppearance: (next: Appearance) => void;
}) {
  const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [error, setError] = useState('');
  const latest = useRef(snapshot); latest.current = snapshot;
  async function effort(code: Effort) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const settings = latest.current.settings;
      const result = await bridge.saveSettings({ ...settings, effort: { ...settings.effort, code } });
      if (!result.ok) throw new Error(result.error);
      latest.current = result.value; update(result.value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Work preferences could not be saved.'); }
    finally { lock.current = false; setBusy(false); }
  }
  return <div className="work-settings-page">
    <section className="settings-content-group"><h2>Reasoning</h2><div className="settings-card"><SettingRow title="Work effort" description="The reasoning level used for Work. Available reasoning depends on the selected model."><SettingsSelect aria-label="Work effort" value={snapshot.settings.effort.code} disabled={busy} onChange={event => void effort(event.target.value as Effort)}>{effortLevels.map(level => <option value={level} key={level}>{effortLabel(level)}</option>)}</SettingsSelect></SettingRow></div></section>
    <section className="settings-content-group"><h2>File and command approvals</h2><p className="settings-notice">These permissions are shared with General settings.</p><ToolApprovalSettings snapshot={snapshot} bridge={bridge} update={update} operations={['read', 'write', 'execute']} /></section>
    <section className="settings-content-group"><h2>Code previews</h2><div className="settings-card">
      <SettingRow title="Diff markers" description="How additions and removals appear in code previews."><SettingsSelect aria-label="Work diff markers" value={appearance.diffMarkers} onChange={event => changeAppearance({ ...appearance, diffMarkers: event.target.value as Appearance['diffMarkers'] })}><option value="color">Color</option><option value="symbols">Symbols</option></SettingsSelect></SettingRow>
      <SettingRow title="Code font size"><input className="settings-value appearance-number" aria-label="Work code font size" type="number" min={10} max={24} value={appearance.codeFontSize} onChange={event => changeAppearance({ ...appearance, codeFontSize: Math.max(10, Math.min(24, Number(event.target.value) || 12)) })} /></SettingRow>
    </div></section>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
