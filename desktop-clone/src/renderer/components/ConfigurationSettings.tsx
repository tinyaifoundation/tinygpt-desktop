import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Check, LoaderCircle, Plus, RefreshCw } from '../icons';
import tinyGptIcon from '../../main/assets/dock-icons/tinygpt-ios-default.png';
import tinyGptProIcon from '../../main/assets/dock-icons/tinygpt-dark.png';
import type { AppSnapshot, DesktopBridge, LocalDiscovery, OpenRouterAccount, Result } from '../../shared/contracts';
import { defaultSettings, openRouterCostTiers, type Settings } from '../../shared/config';
import { costTierLabels } from '../../shared/openrouter-routers';
import { InferenceProviderIcon } from './InferenceProviderIcon';
import { builtInModels, builtInModelId, builtInAvailability, type BuiltInHardware, type BuiltInModelId, type ManagedLocalStatus } from '../../shared/managed-local';
import { ConfigurationMonitor } from './ConfigurationMonitor';
import { SettingRow, Switch } from './AppearanceSettings';
import { SettingsButton as Button } from './ui/settings-button';
import { SettingsSelect } from './ui/settings-select';
import { DialogRoot as Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';

type Method = 'openrouter' | 'local';
type Props = { snapshot: AppSnapshot; bridge: DesktopBridge; update: (value: AppSnapshot) => void };
type ModalProps = Props & { close: () => void };
const methods: { id: Method; name: string; description: string }[] = [
  { id: 'openrouter', name: 'OpenRouter', description: 'Free and paid models with one account' },
  { id: 'local', name: 'Local models', description: 'Connect Ollama, LM Studio, or another local server' },
];
function unwrap<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error); return result.value; }
function InferenceIcon({ method }: { method: Method }) {
  return <InferenceProviderIcon provider={method} />;
}
function BuiltInIcon({ id }: { id: BuiltInModelId }) {
  return <img className="built-in-app-icon" src={id === 'pro' ? tinyGptProIcon : tinyGptIcon} alt="" />;
}
function useAction() {
  const lock = useRef(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function act(operation: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The connection could not be completed.'); }
    finally { lock.current = false; setBusy(false); }
  }
  return { busy, error, act };
}
function ConnectionModal({ method, title, icon, description, busy = false, close, children, footer }: { method: Method; title?: string; icon?: ReactNode; description: string; busy?: boolean; close: () => void; children: ReactNode; footer: ReactNode }) {
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent className="connector-connect-modal inference-connection-modal"><DialogHeader><span className="connector-detail-logo">{icon ?? <InferenceIcon method={method} />}</span><DialogTitle>{title ?? methods.find(item => item.id === method)!.name}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader><div className="inference-modal-content">{children}</div><DialogFooter>{footer}</DialogFooter></DialogContent></Dialog>;
}
function ConnectionButton({ primary = false, ...props }: Omit<ComponentProps<typeof Button>, 'variant'> & { primary?: boolean }) {
  return <Button variant={primary ? 'pill' : 'muted'} {...props} />;
}
function ConnectedStatus({ children = 'Connected' }: { children?: ReactNode }) { return <p className="inference-connection-status" role="status"><Check />{children}</p>; }

function OpenRouterModal({ snapshot, bridge, update, close }: ModalProps) {
  const { busy, error, act } = useAction();
  const [signingIn, setSigningIn] = useState(false);
  const [account, setAccount] = useState<OpenRouterAccount>(); const [checking, setChecking] = useState(false); const [accountError, setAccountError] = useState('');
  const latest = useRef(snapshot); latest.current = snapshot;
  const connection = snapshot.inferenceConnections?.find(item => item.route === 'byok' && item.config.provider === 'openrouter');
  const connected = !!connection?.connected;
  const policy = snapshot.settings.openrouter;
  useEffect(() => {
    if (!connected) { setAccount(undefined); return; }
    let current = true; setChecking(true); setAccountError('');
    void bridge.openRouterAccount().then(result => { if (current) { if (result.ok) setAccount(result.value); else setAccountError(result.error); } }, () => { if (current) setAccountError('Account details could not be checked. Reconnect to try again.'); }).finally(() => { if (current) setChecking(false); });
    return () => { current = false; };
  }, [bridge, connected]);
  const commit = (value: AppSnapshot) => { latest.current = value; update(value); };
  const signIn = () => act(async () => { setSigningIn(true); setAccount(undefined); setAccountError(''); try { commit(unwrap(await bridge.connectOpenRouter())); const result = await bridge.openRouterAccount(); if (result.ok) setAccount(result.value); else setAccountError(result.error); } finally { setSigningIn(false); } });
  const preferences = (patch: Partial<Settings['openrouter']>) => act(async () => {
    const settings = latest.current.settings;
    commit(unwrap(await bridge.openRouterPreferences({ ...settings.openrouter, ...patch })));
  });
  let creditNote = 'Checking your account…';
  if (account?.status === 'free') creditNote = 'Your account has no purchased credits. Paid models require OpenRouter credits.';
  if (account?.status === 'funded') creditNote = '';
  if (account?.status === 'exhausted') creditNote = 'No available credit or spending allowance was found. Paid models require OpenRouter credits.';
  if (account?.status === 'unknown') creditNote = 'OpenRouter does not share your account balance with this connection. Choose All if you have credits.';
  return <ConnectionModal method="openrouter" description={connected ? 'Manage your account and inference preferences.' : 'Sign in to OpenRouter in your browser.'} busy={busy} close={close} footer={<>
    {connected && !signingIn && <ConnectionButton className="inference-disconnect" disabled={busy} onClick={() => void act(async () => { commit(unwrap(await bridge.removeInferenceConnection(connection!.id))); })}>Disconnect</ConnectionButton>}
    {signingIn ? <ConnectionButton primary onClick={() => void bridge.cancelInferenceSignIn()}>Cancel sign-in</ConnectionButton> : connected ? <>
      <ConnectionButton disabled={busy || !snapshot.secureStorageAvailable} onClick={() => void signIn()}>Reconnect</ConnectionButton>
      <ConnectionButton primary disabled={busy} onClick={close}>Done</ConnectionButton>
    </> : <>
      <ConnectionButton disabled={busy} onClick={close}>Cancel</ConnectionButton>
      <ConnectionButton primary disabled={busy || !snapshot.secureStorageAvailable} onClick={() => void signIn()}>{busy && <LoaderCircle className="animate-spin" />}Connect OpenRouter</ConnectionButton>
    </>}
  </>}>
    {signingIn ? <p className="inference-progress" role="status"><LoaderCircle className="animate-spin" />Waiting for browser sign-in…</p> : connected ? <>
      {accountError ? <p role="alert" className="inference-error">{accountError}</p> : <ConnectedStatus>Connected{account?.balance !== undefined && <span className="inference-account-balance">${account.balance.toFixed(2)} available</span>}</ConnectedStatus>}
      {snapshot.activeConnectionId !== connection?.id && <ConnectionButton disabled={busy} onClick={() => void act(async () => { commit(unwrap(await bridge.activateInferenceConnection(connection!.id))); })}>Use for chats</ConnectionButton>}
      <section className="inference-modal-section"><h3>Privacy</h3><SettingRow title="Zero data retention" description="Only use providers that do not retain prompts or replies."><Switch label="Zero data retention" value={policy.zeroDataRetention} disabled={busy} change={value => void preferences({ zeroDataRetention: value })} /></SettingRow><SettingRow title="Allow data collection" description="Allow providers that may use prompts for training."><Switch label="Allow provider data collection" value={policy.allowDataCollection} disabled={busy} change={value => void preferences({ allowDataCollection: value })} /></SettingRow></section>
      <section className="inference-modal-section"><h3>Model access</h3><SettingRow title="Models"><SettingsSelect aria-label="OpenRouter model access" value={policy.access} disabled={busy} onChange={event => void preferences({ access: event.target.value as 'free' | 'paid' })}><option value="free">Free</option><option value="paid">All</option></SettingsSelect></SettingRow>
        {policy.access === 'paid' && <SettingRow title="Cost tier" description="Price range for Auto Router. Higher tiers can cost more."><SettingsSelect aria-label="OpenRouter cost tier" value={policy.costTier} disabled={busy} onChange={event => void preferences({ costTier: event.target.value as Settings['openrouter']['costTier'] })}>{openRouterCostTiers.map(tier => <option key={tier} value={tier}>{costTierLabels[tier]}</option>)}</SettingsSelect></SettingRow>}
        {creditNote && <p className="inference-modal-note" role="status">{checking && !account ? 'Checking your account…' : accountError || creditNote}</p>}</section>
    </> : <p className="inference-modal-note">Choose your account in the browser. Once connected, you can set privacy and model access here.</p>}
    {!snapshot.secureStorageAvailable && <p role="alert" className="inference-error">Secure credential storage is unavailable on this computer.</p>}
    {error && <p role="alert" className="inference-error">{error}</p>}
  </ConnectionModal>;
}

function LocalModelModal({ snapshot, bridge, update, close }: ModalProps) {
  const { busy, error, act } = useAction(); const [discovery, setDiscovery] = useState<LocalDiscovery>(); const [scanned, setScanned] = useState(false);
  const latest = useRef(snapshot); latest.current = snapshot;
  const connected = !!snapshot.settings.local.model;
  const connection = snapshot.inferenceConnections?.find(item => item.route === 'local' && item.config.endpoint === snapshot.settings.local.endpoint);
  const commit = (value: AppSnapshot) => { latest.current = value; update(value); };
  const useServer = async (connection: LocalDiscovery['connections'][number]) => {
    const selected = connection.models.find(model => model.id === latest.current.settings.local.model) ?? connection.models[0];
    if (selected) commit(unwrap(await bridge.useLocalModel(connection.endpoint, selected.id)));
  };
  const scan = () => act(async () => {
    const result = unwrap(await bridge.scanLocalModels()); setDiscovery(result); setScanned(true);
    const available = result.connections.filter(connection => connection.models.length);
    if (!latest.current.settings.local.model && available.length === 1) await useServer(available[0]);
  });
  useEffect(() => { void scan(); }, [bridge]);
  const found = discovery?.connections.find(connection => connection.endpoint === snapshot.settings.local.endpoint && connection.models.some(model => model.id === snapshot.settings.local.model));
  return <ConnectionModal method="local" description="Find models already running in Ollama, LM Studio, or another local app." busy={busy} close={close} footer={<>
    {connected && <ConnectionButton className="inference-disconnect" disabled={busy} onClick={() => void act(async () => { commit(unwrap(await (connection ? bridge.removeInferenceConnection(connection.id) : bridge.disconnectInference('local')))); })}>Disconnect</ConnectionButton>}
    <ConnectionButton disabled={busy} onClick={() => void scan()}>{busy ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}{busy ? 'Scanning…' : 'Scan again'}</ConnectionButton><ConnectionButton primary disabled={busy} onClick={close}>Done</ConnectionButton>
  </>}>
    {busy && !scanned && <p className="inference-progress" role="status"><LoaderCircle className="animate-spin" />Scanning your computer…</p>}
    {found && <><ConnectedStatus /><div className="inference-server-summary"><strong>{found.name}</strong><span>{found.endpoint}</span><small>{found.models.length} {found.models.length === 1 ? 'model' : 'models'} available · Parameters detected automatically</small></div>{snapshot.activeConnectionId !== connection?.id && <ConnectionButton disabled={busy} onClick={() => void act(() => useServer(found))}>Use for chats</ConnectionButton>}</>}
    {scanned && !found && connected && <p role="status" className="inference-modal-note">Your saved server is unavailable. Start it and scan again.</p>}
    {scanned && !discovery?.connections.length && <p role="status" className="inference-modal-note">No local model server found. Start your server, then scan again.</p>}
    {!!discovery?.connections.length && <div className="inference-server-list">{discovery.connections.filter(connection => connection !== found).map(connection => <div className="inference-server-row" key={connection.endpoint}><span><strong>{connection.name}</strong><small>{connection.endpoint}</small><small>{connection.models.length ? `${connection.models.length} models available` : 'Load a chat model, then scan again.'}</small></span><ConnectionButton disabled={busy || !connection.models.length} onClick={() => void act(() => useServer(connection))}>Connect</ConnectionButton></div>)}</div>}
    {discovery?.unavailable.map(item => <p className="inference-modal-note" key={item.endpoint}>{item.endpoint}: {item.message}</p>)}
    {error && <p role="alert" className="inference-error">{error}</p>}
  </ConnectionModal>;
}


function BuiltInModal({ id, status, snapshot, bridge, update, close }: ModalProps & { id: BuiltInModelId; status?: ManagedLocalStatus }) {
  const { busy, error, act } = useAction();
  const [stopError, setStopError] = useState('');
  const model = builtInModels[id];
  const settingUp = busy || !!status && ['downloading', 'verifying', 'extracting', 'starting', 'stopping'].includes(status.phase);
  const running = status?.phase === 'running';
  const cancel = async () => { const result = await bridge.stopBuiltInModel(id); if (result.ok) update(result.value); else setStopError(result.error); };
  const progress = status?.total && status.downloaded !== undefined ? Math.min(100, Math.floor(status.downloaded / status.total * 100)) : undefined;
  return <ConnectionModal method="local" title={model.name} icon={<BuiltInIcon id={id} />} description={id === 'pro' ? 'Available for this device. Download once, then use it offline.' : 'Your included model. Runs on this device without an account.'} busy={settingUp} close={close} footer={<>
    {settingUp ? <ConnectionButton onClick={() => void cancel()}>Cancel setup</ConnectionButton> : <>
      {running && <ConnectionButton className="inference-disconnect" onClick={() => void cancel()}>Stop</ConnectionButton>}
      <ConnectionButton onClick={close}>Done</ConnectionButton>
      <ConnectionButton primary onClick={() => void act(async () => { update(unwrap(await bridge.startBuiltInModel(id))); })}>{running ? 'Use model' : status?.installed ? 'Start model' : 'Download & set up'}</ConnectionButton>
    </>}
  </>}>
    <div className="built-in-setup-summary"><span>Setup size</span><strong>{((model.downloadBytes + (id === 'pro' && snapshot.settings.builtIn?.proMtp !== false ? builtInModels.pro.predictionBytes : 0)) / 1e9).toFixed(1)} GB</strong></div>
    {id === 'pro' && <SettingRow title="Response acceleration" description={running ? 'Stop Pro to change this setting.' : 'Uses extra device memory and a 1.7 GB support download. Speed varies by task.'}><Switch label="Pro response acceleration" value={snapshot.settings.builtIn?.proMtp !== false} disabled={settingUp || running} change={proMtp => void act(async () => { update(unwrap(await bridge.saveSettings({ ...snapshot.settings, builtIn: { proMtp } }))); })} /></SettingRow>}
    <p className="inference-progress" role="status">{settingUp && <LoaderCircle className="animate-spin" />}{status?.message || 'Ready to set up.'}{progress !== undefined && settingUp ? ' '+progress+'%' : ''}</p>
    {settingUp && <progress aria-label="Setup progress" max={status?.total || 100} value={status?.total ? status.downloaded || 0 : undefined} />}
    {running && <ConnectedStatus>Ready in your model picker</ConnectedStatus>}
    {((error && !error.includes('canceled')) || stopError) && <p role="alert" className="inference-error">{stopError || error}</p>}
  </ConnectionModal>;
}

export function ConfigurationSettings(props: Props) {
  const [method, setMethod] = useState<Method | null>(null);
  const [connectionId, setConnectionId] = useState<string>();
  const [builtIn, setBuiltIn] = useState<BuiltInModelId>();
  const [hardware, setHardware] = useState<BuiltInHardware>();
  const [checking, setChecking] = useState(false);
  const [scanError, setScanError] = useState('');
  const [models, setModels] = useState<Partial<Record<BuiltInModelId, ManagedLocalStatus>>>({});
  const mounted = useRef(true);
  const scanLock = useRef(false);
  const scan = async () => {
    if (scanLock.current) return; scanLock.current = true; setChecking(true); setScanError('');
    try { const value = unwrap(await props.bridge.builtInHardware()); if (mounted.current) setHardware(value); }
    catch { if (mounted.current) { setHardware(undefined); setScanError('Device check could not be completed. Try again.'); } }
    finally { scanLock.current = false; if (mounted.current) setChecking(false); }
  };
  useEffect(() => {
    mounted.current = true; void scan();
    const poll = async () => { try { const result = await props.bridge.builtInStatus(); if (mounted.current && result.ok) setModels(result.value); } catch { /* Window closed. */ } };
    void poll(); const timer = setInterval(() => void poll(), 700);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [props.bridge]);
  const connections = props.snapshot.inferenceConnections ?? [];
  const locals = connections.filter(item => item.route === 'local' && !builtInModelId(item.config.model));
  const connected: Record<Method, boolean> = { openrouter: connections.some(item => item.route === 'byok' && item.config.provider === 'openrouter' && item.connected), local: !!locals.length };
  const open = (method: Method, id?: string) => { setConnectionId(id); setMethod(method); };
  const close = () => { setMethod(null); setConnectionId(undefined); };
  const selectedLocal = locals.find(item => item.id === connectionId) ?? locals.find(item => item.id === props.snapshot.activeConnectionId) ?? locals[0];
  const localProps = { ...props, snapshot: { ...props.snapshot, settings: { ...props.snapshot.settings, local: selectedLocal?.route === 'local' ? selectedLocal.config : defaultSettings.local } } };
  const visibleBuiltIns: BuiltInModelId[] = hardware?.proCompatible || models.pro?.installed ? ['included', 'pro'] : ['included'];
  const selectedBuiltIn = props.snapshot.settings.route === 'local' ? builtInModelId(props.snapshot.settings.local.model) : undefined;
  return <div className="configuration-page"><div className="catalog-header"><header className="catalog-heading"><h1>Configuration</h1><p>Choose how TinyGPT runs.</p></header></div>
    <ConfigurationMonitor bridge={props.bridge} preferredDevice={hardware?.device?.uuid} />
    <div className="settings-card configuration-residency-settings"><SettingRow title="Keep local models loaded" description="Automatic mode releases idle model memory and reloads when you type or send. Desktop and mobile work share the activity timer."><Switch label="Keep local models loaded" value={!!props.snapshot.settings.modelResidency?.keepLoaded} change={keepLoaded => void props.bridge.saveSettings({ ...props.snapshot.settings, modelResidency: { idleMinutes: props.snapshot.settings.modelResidency?.idleMinutes ?? 10, keepLoaded } }).then(value => { if (value.ok) props.update(value.value); })} /></SettingRow>
    <SettingRow title="Chat idle timeout" description="Active conversations and background work stay loaded."><SettingsSelect aria-label="Chat idle timeout" value={props.snapshot.settings.modelResidency?.idleMinutes ?? 10} onChange={event => void props.bridge.saveSettings({ ...props.snapshot.settings, modelResidency: { keepLoaded: !!props.snapshot.settings.modelResidency?.keepLoaded, idleMinutes: Number(event.target.value) } }).then(value => { if (value.ok) props.update(value.value); })}>{[5, 10, 15, 30, 60].map(value => <option key={value} value={value}>{value} minutes</option>)}</SettingsSelect></SettingRow></div>
    <section className="configuration-section" aria-label="Built-in models"><div className="built-in-section-heading"><div><h2>Built-in models</h2><p>Ready to use on this device.</p></div><Button disabled={checking} onClick={() => void scan()}>{checking ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}{checking ? 'Checking device…' : 'Check device'}</Button></div>
      <div className="catalog-grid configuration-grid">{visibleBuiltIns.map(id => { const model = builtInModels[id], status = models[id], available = builtInAvailability(status, selectedBuiltIn === id, status?.phase === 'running' || (id === 'pro' ? !!hardware?.proCompatible : !!hardware?.includedSupported)); return <button type="button" className="catalog-card configuration-card" key={id} disabled={id === 'included' && !hardware?.includedSupported && status?.phase !== 'running'} aria-label={'Configure '+model.name} onClick={() => setBuiltIn(id)}>
        <span className="catalog-card-icon"><BuiltInIcon id={id} /></span><span className="catalog-card-copy"><strong>{model.name}</strong><small>{id === 'included' ? 'Runs locally. No account needed.' : 'Optional download for this device.'}</small></span>{available ? <span className="configuration-connected"><Check />{available}</span> : status?.phase === 'error' ? <span className="configuration-availability">Needs attention</span> : status && !['idle', 'running'].includes(status.phase) ? <span className="configuration-availability configuration-progress"><LoaderCircle className="animate-spin" />{status.phase === 'downloading' ? 'Downloading' : status.phase === 'stopping' ? 'Stopping' : 'Setting up'}</span> : <Plus aria-hidden="true" />}
      </button>; })}</div>
      {(scanError || hardware && !hardware.includedSupported) && <p className="built-in-scan-note" role={scanError ? 'alert' : 'status'}>{scanError || hardware?.message}</p>}
    </section>
    <section className="configuration-section" aria-label="Model connections"><div className="configuration-section-heading"><h2>Connections</h2><p>Use an account or an existing local server.</p></div><div className="catalog-grid configuration-grid">{methods.map(item => <button type="button" className="catalog-card configuration-card" key={item.id} aria-label={'Configure '+item.name} onClick={() => open(item.id, item.id === 'local' ? locals[0]?.id : undefined)}><span className="catalog-card-icon"><InferenceIcon method={item.id} /></span><span className="catalog-card-copy"><strong>{item.name}</strong><small>{item.description}</small></span>{connected[item.id] ? <span className="configuration-connected"><Check />Connected</span> : <Plus aria-hidden="true" />}</button>)}</div></section>
    {method === 'openrouter' && <OpenRouterModal {...props} close={close} />}
    {method === 'local' && <LocalModelModal {...localProps} close={close} />}
    {builtIn && <BuiltInModal {...props} id={builtIn} status={models[builtIn]} close={() => setBuiltIn(undefined)} />}
  </div>;
}
