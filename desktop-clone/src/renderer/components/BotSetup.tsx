import { useState } from 'react';
import { ArrowLeft, ArrowRight, Loader2 } from '../icons';
import { BotWelcome } from './BotWelcome';
import { Button } from './ui/button';
import { BotAccessSettings } from './BotAccessSettings';
import { defaultBotConfiguration } from '../../shared/bot';
import type { BotDesign } from '../lib/bot';
import type { AppSnapshot, DesktopBridge } from '../../shared/contracts';
import type { BotSnapshot, BotSetup as Setup } from '../../shared/bot';
import type { LibrarySnapshot } from '../../shared/chat';
import { useBotSetupTransition } from '../lib/bot-setup-transition';
import { BotPluginPermissions } from './BotPluginPermissions';
import { SettingRow, Switch } from './AppearanceSettings';
import { SettingsSelect } from './ui/settings-select';

export function BotSetup({ design, changeDesign, status, bridge, snapshot, updateSnapshot, library, openSettings, complete, close }: {
  design: BotDesign; changeDesign: (value: BotDesign) => void; status: BotSnapshot; bridge: DesktopBridge;
  snapshot: AppSnapshot; updateSnapshot: (value: AppSnapshot) => void; library: LibrarySnapshot; openSettings: () => void; complete: (setup: Setup) => Promise<void>; close?: () => void;
}) {
  const [originalDesign] = useState(design);
  const [step, setStep] = useState(status.conversationId && !status.configured ? 'connection' : 'appearance');
  const [configuration, setConfiguration] = useState(status.configured ? status.configuration ?? defaultBotConfiguration : { ...defaultBotConfiguration, background: true, browser: true, heartbeat: '1h' as const });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [editorTab,setEditorTab] = useState<'appearance' | 'permissions' | 'behavior'>('appearance');
  const working = library.activeRuns.some(run => run.conversationId === status.conversationId);
  const { root, transition } = useBotSetupTransition();
  const setup = { name: design.name, projectId: status.projectId, configuration };
  function prepare() { transition(() => { setStep('connection'); setError(''); }, 'forward'); void bridge.prepareBot(setup).then(result => { if (!result.ok) setError(result.error); }, () => setError('Your bot could not get ready. Try again.')); }
  async function finish() {
    setError(''); setStarting(true);
    try { if (status.phase === 'error' || status.phase === 'idle') { const prepared = await bridge.prepareBot(setup); if (!prepared.ok) throw Error(prepared.error); } await complete(setup); }
    catch (error) { setError(error instanceof Error ? error.message : 'Your bot could not get ready. Try again.'); }
    finally { setStarting(false); }
  }
  const connectionStep = step === 'connection';
  const editorControls = editorTab === 'permissions' ? <div className="bot-settings-panel" aria-label="Bot permissions">
    <div className="bot-settings-capabilities"><SettingRow title="Browse the web"><Switch label="Agent Browser" value={configuration.browser} disabled={starting || working} change={browser => setConfiguration({...configuration,browser})} /></SettingRow>
    <SettingRow title="Run commands"><Switch label="Bot command access" value={configuration.commands !== 'deny'} disabled={starting || working} change={allowed => setConfiguration({...configuration,commands:allowed ? 'ask' : 'deny'})} /></SettingRow></div>
    <BotPluginPermissions bridge={bridge} />
  </div> : editorTab === 'behavior' ? <div className="bot-settings-panel" aria-label="Bot behavior"><h2>Your personal assistant</h2>
    <SettingRow title="Remember useful details"><Switch label="Bot memory" value={configuration.memory} disabled={starting || working} change={memory => setConfiguration({...configuration,memory})} /></SettingRow>
    <SettingRow title="Take initiative"><Switch label="Bot background tasks" value={configuration.background} disabled={starting || working} change={background => setConfiguration({...configuration,background,heartbeat:background && configuration.heartbeat === 'off' ? '1h' : configuration.heartbeat})} /></SettingRow>
    {configuration.background && <SettingRow title="Check-in frequency"><SettingsSelect aria-label="Bot check-in frequency" value={configuration.heartbeat} disabled={starting || working} onChange={event => setConfiguration({...configuration,heartbeat:event.target.value as typeof configuration.heartbeat})}><option value="off">Off</option><option value="30m">Every 30 minutes</option><option value="1h">Every hour</option></SettingsSelect></SettingRow>}
    <p className="bot-settings-hint">Your bot can reach out with useful updates while TinyGPT is open. Proactive checks run between 8 AM and 10 PM.</p>
  </div> : undefined;
  return <BotWelcome design={design} changeDesign={changeDesign} next={prepare} sectionRef={root}
    toolbar={close ? <div className="bot-settings-tabs" role="group" aria-label="Bot settings">{(['appearance','permissions','behavior'] as const).map(tab => <button type="button" key={tab} aria-pressed={editorTab === tab} onClick={() => setEditorTab(tab)}>{tab[0].toUpperCase()+tab.slice(1)}</button>)}</div> : undefined}
    sectionLabel={connectionStep ? 'Bot setup' : 'Bot personalization'}
    heading={connectionStep ? <><span>Let's get</span><span>{design.name} ready.</span></> : undefined}
    headingLabel={connectionStep ? `Let's get ${design.name} ready.` : undefined}
    controls={close ? editorControls : connectionStep ? <div className="bot-setup-controls">
    <BotAccessSettings value={configuration} change={setConfiguration} busy={starting} compact />
    <p className="bot-setup-note">Your bot has its own workspace. Adjust access anytime in Bot settings.</p>
    {(error || status.error) && <p className="bot-setup-error" role="alert">{error || status.error}</p>}
    </div> : undefined}
    footer={close ? <><span className="bot-setup-error" role="alert">{error}</span>{working && <span className="bot-settings-hint">Your bot is working. Plugin access can still be changed.</span>}<Button variant="ghost" size="action" disabled={starting} onClick={() => { changeDesign(originalDesign); close(); }}>Cancel</Button><Button variant="pill" size="action" disabled={starting || working} onClick={() => void finish()}>{starting ? <><Loader2 className="animate-spin" />Saving…</> : 'Save'}</Button></> : connectionStep ? <><span className="bot-setup-status" role="status">{status.phase === 'preparing' ? <><Loader2 className="animate-spin" />Getting your bot ready…</> : status.phase === 'ready' ? 'Ready when you are.' : ''}</span><Button variant="ghost" size="action" disabled={starting} onClick={() => transition(() => setStep('appearance'), 'back')}><ArrowLeft />Go back</Button><Button variant="pill" size="action" disabled={starting} onClick={() => void finish()}>{starting ? <><Loader2 className="animate-spin" />Getting ready…</> : <>Start chatting<ArrowRight /></>}</Button></> : undefined} />;
}
