import { RemoteControlSettings } from './RemoteControlSettings';
import { ComputerSettings } from './ComputerSettings';
import { ArchivedChatsSettings } from './ArchivedChatsSettings';
import { DiagnosticsSettings } from './DiagnosticsSettings';
import { BrowserSettings } from './BrowserSettings';
import { VoiceSettings } from './VoiceSettings';
import { GeneralSettings } from './GeneralSettings';
import { BotSettings } from './BotSettings';
import { WorkSettings } from './WorkSettings';
import { NotificationSettings } from './NotificationSettings';
import { MemorySettings } from './MemorySettings';
import { PluginLibrary } from './PluginLibrary';
import { ProfileUsage } from './ProfileUsage';
import { useRef, useState, type ComponentType } from 'react';
import { Activity, Archive, ArrowLeft, Bell, UserRound, Sun, Mic, MonitorCog, WandSparkles, Keyboard, MousePointer2, Devices, Blocks, Globe, Programming, Settings, Search, X, Pencil, Check, ImagePlus } from '../icons';
import type { AppSnapshot, DesktopBridge } from '../../shared/contracts';
import type { LibrarySnapshot } from '../../shared/chat';
import { AppearanceSettings, SettingRow } from './AppearanceSettings';
import { ConfigurationSettings } from './ConfigurationSettings';
import { initials, profileNames, profileSchema, type Appearance, type Profile } from '../lib/appearance';
import { SettingsButton as Button } from './ui/settings-button';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { normalizeSettingsSearch, searchSettings, type SettingsSearchEntry } from '../lib/settings-search';
import { useSettingsSearchNavigation, type SettingsSearchRequest } from '../lib/settings-search-navigation';

const groups: { label: string; items: [string, ComponentType][] }[] = [
  { label: 'Personal', items: [['General', Settings], ['Configuration', MonitorCog], ['Notifications', Bell], ['Profile', UserRound], ['Appearance', Sun], ['Voice', Mic], ['Personalization', WandSparkles]] },
  { label: 'Integrations', items: [['Computer use', MousePointer2], ['Remote Control', Devices], ['Plugins', Blocks], ['Browser', Globe]] },
  { label: 'Work', items: [['Work settings', Programming], ['Bot', WandSparkles]] },
  { label: 'More', items: [['Keyboard shortcuts', Keyboard], ['Archived chats', Archive], ['Diagnostics', Activity]] },
];
function ProfileSettings({ profile, change, library, bridge }: { profile: Profile; change: (profile: Profile) => void; library: LibrarySnapshot; bridge: DesktopBridge }) {
  const [editing, setEditing] = useState(false); const [draft, setDraft] = useState(() => ({ ...profile, ...profileNames(profile) })); const [error, setError] = useState(''); const [saving, setSaving] = useState(false); const saveLock = useRef(false); const file = useRef<HTMLInputElement>(null);
  async function save() {
    if (saveLock.current) return;
    const firstName = draft.firstName.trim(), lastName = draft.lastName.trim();
    const parsed = profileSchema.safeParse({ ...draft, firstName, lastName, name: [firstName, lastName].filter(Boolean).join(' ') || 'Personal' });
    if (!parsed.success) { setError('Use up to 60 characters for each name.'); return; }
    saveLock.current = true; setSaving(true); setError('');
    try {
      const previous = profileNames(profile);
      if (firstName !== previous.firstName || lastName !== previous.lastName) {
        const result = await bridge.saveProfileName({ firstName, lastName });
        if (!result.ok) throw new Error(result.error);
      }
      change(parsed.data); setEditing(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Your profile could not be saved.'); }
    finally { saveLock.current = false; setSaving(false); }
  }
  async function avatar(image?: File) {
    if (!image) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.type) || image.size > 2000000) { setError('Choose a PNG, JPEG, or WebP smaller than 2 MB.'); return; }
    const reader = new FileReader(); reader.onload = () => { setDraft(previous => ({ ...previous, avatar: String(reader.result) })); setError(''); }; reader.onerror = () => setError('That photo could not be read.'); reader.readAsDataURL(image);
  }
  return <div className="settings-profile-page"><div className="settings-profile-toolbar"><Button disabled={saving} onClick={() => { setDraft({ ...profile, ...profileNames(profile) }); setEditing(!editing); setError(''); }}>{editing ? <X /> : <Pencil />}{editing ? 'Cancel' : 'Edit'}</Button></div><section className="profile-hero">
    <button type="button" className={`profile-avatar ${editing ? 'profile-avatar-upload' : ''}`} disabled={!editing} aria-label="Upload profile photo" onClick={() => file.current?.click()}>{(editing ? draft : profile).avatar ? <img alt="" src={(editing ? draft : profile).avatar} /> : initials(editing ? draft : profile)}{editing && <span><ImagePlus /></span>}</button>
    {editing ? <><input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => { void avatar(event.target.files?.[0]); event.currentTarget.value = ''; }} /><Button type="button" className="profile-upload-action" onClick={() => file.current?.click()}>Upload photo</Button>{draft.avatar && <Button onClick={() => setDraft({ ...draft, avatar: '' })}>Remove photo</Button>}
      <label className="profile-edit-field"><span>First name</span><Input aria-label="First name" autoComplete="given-name" disabled={saving} value={draft.firstName} maxLength={60} onChange={event => setDraft({ ...draft, firstName: event.target.value })} /></label><label className="profile-edit-field"><span>Last name</span><Input aria-label="Last name" autoComplete="family-name" disabled={saving} value={draft.lastName} maxLength={60} onChange={event => setDraft({ ...draft, lastName: event.target.value })} /></label>
      <p className="profile-memory-hint">Your name is saved as a personal memory. Manage sharing in Personalization.</p>
      <Button className="profile-save-button" disabled={saving} onClick={() => void save()}><Check />{saving ? 'Saving…' : 'Save changes'}</Button>
    </> : <><h2>{profile.name}</h2><div className="profile-identity"><span className="profile-tier">Local profile</span></div></>}
  </section><ProfileUsage bridge={bridge} />{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</div>;
}
export function SettingsWorkspace({ pluginContext, snapshot, library, bridge, update, updateLibrary, close, section, select, appearance, changeAppearance, profile, changeProfile }: {
  pluginContext?: { conversationId: string | null; projectId: string | null }; snapshot: AppSnapshot; library: LibrarySnapshot; updateLibrary: (value: LibrarySnapshot) => void; bridge: DesktopBridge; update: (value: AppSnapshot) => void; close: () => void; section: string; select: (section: string) => void; appearance: Appearance; changeAppearance: (next: Appearance) => void; profile: Profile; changeProfile: (next: Profile) => void;
}) {
  const [query, setQuery] = useState('');
  const [searchRequest, setSearchRequest] = useState<SettingsSearchRequest | null>(null);
  const requestKey = useRef(0);
  const content = useRef<HTMLDivElement>(null);
  const nav = useRef<HTMLElement>(null);
  const searching = !!query.trim(), normalizedQuery = normalizeSettingsSearch(query);
  const results = searching ? searchSettings(query) : [];
  const matches = groups.map(group => ({ ...group, items: group.items.filter(([label]) => !searching || !!normalizedQuery && (normalizeSettingsSearch(label).includes(normalizedQuery) || results.some(result => result.section === label))) })).filter(group => group.items.length);
  const jump = (entry: SettingsSearchEntry) => { setSearchRequest({ entry, key: ++requestKey.current }); select(entry.section); };
  useSettingsSearchNavigation(searchRequest, section, content);
  const unavailable: Record<string, string> = {};
  if (!groups.some(group => group.items.some(([label]) => label === section))) section = 'General';
  return <div className="settings-workspace"><aside className="settings-sidebar"><div className="settings-window-row window-drag" /><button type="button" className="settings-back-button" onClick={close}><ArrowLeft />Back to TinyGPT</button><div className="settings-search-row"><Search /><input aria-label="Search settings" placeholder="Search settings" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setQuery(''); } else if (event.key === 'Enter' && results[0]) { event.preventDefault(); jump(results[0]); } else if (event.key === 'ArrowDown' && results.length) { event.preventDefault(); nav.current?.querySelector<HTMLButtonElement>('.settings-search-result')?.focus(); } }} />{query && <button type="button" aria-label="Clear settings search" onClick={() => setQuery('')}><X /></button>}</div><ScrollArea className="settings-nav-scroll" viewportClassName="settings-scroll-viewport"><nav ref={nav} className="settings-nav" aria-label="Settings sections">{searching && results.length > 0 && <p className="settings-search-count" role="status">{results.length} matching {results.length === 1 ? 'setting' : 'settings'}</p>}{matches.map(group => <div className="settings-nav-group" key={group.label}><div className="settings-nav-heading">{group.label}</div>{group.items.map(([label, Icon]) => <div className="settings-nav-section" key={label}><button type="button" className={`settings-nav-item ${section === label ? 'is-selected' : ''}`} aria-current={section === label ? 'page' : undefined} onClick={() => { setSearchRequest(null); select(label); }}><span className="settings-nav-icon"><Icon /></span>{label}</button>{searching && results.filter(result => result.section === label).map(result => <button type="button" className="settings-search-result" key={result.id} aria-label={`${result.title} in ${label}`} title={result.description} onClick={() => jump(result)}><span>{result.title}</span><small>{result.description}</small></button>)}</div>)}</div>)}{!matches.length && <p className="settings-no-results" role="status">No settings found</p>}</nav></ScrollArea></aside><main className="settings-main"><div className="settings-top-drag window-drag" onDoubleClick={() => { void bridge.windowControl('maximize'); }} /><ScrollArea className="settings-content" viewportClassName="settings-scroll-viewport"><div ref={content} className={`settings-content-inner ${section === 'Configuration' ? 'configuration-content' : ''}`} key={section}>{section !== 'Configuration' && <h1>{section}</h1>}
    {section === 'Bot' ? <BotSettings bridge={bridge} /> : section === 'Remote Control' ? <RemoteControlSettings bridge={bridge} library={library} updateLibrary={updateLibrary} conversationId={pluginContext?.conversationId} /> : section === 'Computer use' ? <ComputerSettings snapshot={snapshot} bridge={bridge} update={update} /> : section === 'Notifications' ? <NotificationSettings snapshot={snapshot} bridge={bridge} update={update} /> : section === 'Configuration' ? <ConfigurationSettings snapshot={snapshot} bridge={bridge} update={update} /> : section === 'Archived chats' ? <ArchivedChatsSettings library={library} bridge={bridge} updateLibrary={updateLibrary} /> : section === 'Plugins' ? <PluginLibrary bridge={bridge} library={library} context={pluginContext} embedded /> : section === 'Diagnostics' ? <DiagnosticsSettings bridge={bridge} /> : section === 'Personalization' ? <MemorySettings bridge={bridge} library={library} /> : section === 'Browser' ? <BrowserSettings snapshot={snapshot} bridge={bridge} update={update} /> : section === 'Voice' ? <VoiceSettings snapshot={snapshot} bridge={bridge} update={update} /> : section === 'Appearance' ? <AppearanceSettings value={appearance} change={changeAppearance} /> : section === 'Profile' ? <ProfileSettings profile={profile} change={changeProfile} library={library} bridge={bridge} /> : section === 'General' ? <GeneralSettings snapshot={snapshot} bridge={bridge} update={update} /> : section === 'Work settings' ? <WorkSettings snapshot={snapshot} bridge={bridge} update={update} appearance={appearance} changeAppearance={changeAppearance} /> : section === 'Keyboard shortcuts' ? <section className="settings-content-group"><h2>Navigation</h2><div className="settings-card">{[['New chat', 'J'], ['Toggle sidebar', 'B'], ['Find in conversation', 'F'], ['Search chats', 'K']].map(([label, key]) => <SettingRow key={key} title={label}><kbd>{snapshot.platform === 'darwin' ? '⌘' : 'Ctrl'} {key}</kbd></SettingRow>)}</div></section> : <section className="settings-content-group"><h2>{section}</h2><div className="settings-card settings-feature-status"><p>{unavailable[section] ?? 'This integration is still being connected.'}</p><span>Coming soon</span></div></section>}
  </div></ScrollArea></main></div>;
}



