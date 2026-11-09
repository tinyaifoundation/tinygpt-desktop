import { useEffect, useState } from 'react';
import { Globe, ShieldCheck } from '../icons';
import type { AppSnapshot, DesktopBridge } from '../../shared/contracts';
import type { BrowserPreferences } from '../../shared/config';
import type { BrowserHistoryEntry } from '../../shared/workspace';
import { SettingRow, Switch } from './AppearanceSettings';
import { SettingsSelect } from './ui/settings-select';
import { SettingsButton as Button } from './ui/settings-button';
import { Dialog } from './ui/dialog';

export function BrowserSettings({ snapshot, bridge, update }: { snapshot: AppSnapshot; bridge: DesktopBridge; update: (value: AppSnapshot) => void }) {
  const [history, setHistory] = useState<BrowserHistoryEntry[]>([]);
  const [loaded, setLoaded] = useState(false); const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(''); const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<'history' | 'all' | null>(null);
  useEffect(() => { let active = true; void bridge.browserHistory().then(result => { if (!active) return; if (result.ok) setHistory(result.value); else setError(result.error); setLoaded(true); }, () => { if (active) { setError('Browser history could not be loaded.'); setLoaded(true); } }); return () => { active = false; }; }, [bridge]);
  async function change(patch: Partial<BrowserPreferences>) {
    setBusy(true); setError(''); setNotice('');
    try { const result = await bridge.saveSettings({ ...snapshot.settings, browser: { ...snapshot.settings.browser, ...patch } }); if (!result.ok) throw new Error(result.error); update(result.value); setNotice('Saved'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Browser settings could not be saved.'); }
    finally { setBusy(false); }
  }
  async function clear() {
    if (!confirm) return;
    setBusy(true); setError(''); setNotice('');
    try { const result = await bridge.clearBrowserData(confirm); if (!result.ok) throw new Error(result.error); setHistory([]); setNotice(confirm === 'all' ? 'Browser history, cookies, site data, and cache cleared.' : 'Browsing history cleared.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Browsing data could not be cleared.'); }
    finally { setBusy(false); setConfirm(null); }
  }
  const value = snapshot.settings.browser;
  return <div className="browser-settings-page"><p className="browser-settings-intro">Manage how the built-in browser opens links and handles site data.</p>
    <fieldset disabled={busy} className="browser-settings-fields">
      <section className="settings-content-group"><h2>Privacy</h2><div className="settings-card">
        <div className="settings-row browser-settings-feature"><ShieldCheck /><div className="browser-setting-description"><div className="settings-row-title">TinyGPT AdBlock</div><p>Block requests to common ad and tracking domains. Reload open pages after changing this setting.</p></div><Switch label="TinyGPT AdBlock" value={value.adBlock} change={adBlock => void change({ adBlock })} /></div>
        <SettingRow title="Site verification" description="TinyGPT uses a normal Chromium browser profile. When a page needs verification or sign-in, the same tab opens for you; the task resumes after verification clears."><span className="settings-value">Built in</span></SettingRow>
      </div></section>
      <section className="settings-content-group"><h2>General</h2><div className="settings-card">
        <SettingRow title="Default search engine" description="Search and page extraction use the Chromium packaged with TinyGPT."><SettingsSelect aria-label="Default search engine" className="control" value={value.engine} onChange={event => void change({ engine: event.target.value as BrowserPreferences['engine'] })}><option value="google">Google</option><option value="bing">Bing</option><option value="brave">Brave</option><option value="duckduckgo">DuckDuckGo</option></SettingsSelect></SettingRow>
        <SettingRow title="Web link open destination" description="Where response links, citations, sources, and new-window links from websites open."><SettingsSelect aria-label="Web link open destination" className="control" value={value.webLinkDestination} onChange={event => void change({ webLinkDestination: event.target.value as BrowserPreferences['webLinkDestination'] })}><option value="workspace">TinyGPT</option><option value="system">Default browser</option></SettingsSelect></SettingRow>
        <SettingRow title="Local link open destination" description="Where localhost links open."><SettingsSelect aria-label="Local link open destination" className="control" value={value.localLinkDestination} onChange={event => void change({ localLinkDestination: event.target.value as BrowserPreferences['localLinkDestination'] })}><option value="workspace">TinyGPT</option><option value="system">Default browser</option></SettingsSelect></SettingRow>
        <SettingRow title="Show full URL" description="Include the path, query, and fragment when the address bar is not focused."><Switch label="Show full URL" value={value.showFullUrl} change={showFullUrl => void change({ showFullUrl })} /></SettingRow>
        <SettingRow title="Browsing data" description="Clear history, cookies, site data, and cache from shared and isolated Project profiles. Downloaded files and saved chat sources remain."><Button onClick={() => setConfirm('all')}>Clear browsing data</Button></SettingRow>
      </div></section>
      <section className="settings-content-group"><div className="browser-settings-section-header"><h2>Browsing history</h2><Button disabled={!loaded || !history.length} onClick={() => setConfirm('history')}>Clear history</Button></div><div className="settings-card browser-history-card">
        {!loaded ? <p className="browser-history-empty" role="status">Loading browser history…</p> : !history.length ? <p className="browser-history-empty">No pages visited yet.</p> : history.map((entry, index) => <div className="browser-history-row" key={`${entry.visitedAt}-${index}`}><Globe /><div><strong>{entry.title || entry.url}</strong><small title={entry.url}>{entry.url}</small></div><time dateTime={new Date(entry.visitedAt).toISOString()}>{new Date(entry.visitedAt).toLocaleDateString()}</time></div>)}
      </div></section>
    </fieldset>
    {notice && <p className="settings-notice" role="status">{notice}</p>}{error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    <Dialog open={!!confirm} change={open => { if (!open && !busy) setConfirm(null); }} title={confirm === 'all' ? 'Clear browsing data?' : 'Clear browser history?'} description={confirm === 'all' ? 'This signs you out of websites in TinyGPT, including isolated Projects. Downloaded files and saved chat sources remain.' : 'Clear the list of visited pages and back/forward history. Open tabs, website sign-ins, downloaded files, and saved chat sources remain.'}><div className="dialog-actions"><Button disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button><Button disabled={busy} onClick={() => void clear()}>{busy ? 'Clearing…' : 'Clear'}</Button></div></Dialog>
  </div>;
}
