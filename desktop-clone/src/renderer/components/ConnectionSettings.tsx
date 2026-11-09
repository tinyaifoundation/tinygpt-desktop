import { SettingsSelect } from './ui/settings-select';
import { useState } from 'react';
import { Check, Loader2, PlugZap, Trash2 } from '../icons';
import { settingsSchema, providerPresets, type ApprovalRule, type Settings as SettingsType, type ToolPermissions } from '../../shared/config';
import type { AppSnapshot, ConnectionReport, DesktopBridge, Result } from '../../shared/contracts';
import { SettingsButton as Button } from './ui/settings-button';
import { Input } from './ui/input';
import { SettingRow, Switch } from './AppearanceSettings';
import type { ReasoningProfile } from '../../shared/effort';

function unwrap<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error); return result.value; }

export function ConnectionSettings({ snapshot, bridge, update, section, initialRoute }: {
  snapshot: AppSnapshot; bridge: DesktopBridge; update: (value: AppSnapshot) => void; section: 'Configuration' | 'General' | 'Browser'; initialRoute?: 'byok' | 'local';
}) {
  const [draft, setDraft] = useState<SettingsType>(() => ({ ...structuredClone(snapshot.settings), ...(initialRoute ? { route: initialRoute } : {}) }));
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [report, setReport] = useState<ConnectionReport | null>(null);
  const route = draft.route;
  const connection = section === 'Configuration';

  async function act(operation: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The request could not be completed.'); }
    finally { setBusy(false); }
  }
  async function persist(): Promise<AppSnapshot> {
    const parsed = settingsSchema.safeParse(draft);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Check your settings.');
    let next = unwrap(await bridge.saveSettings(parsed.data));
    update(next);
    if (secret && route !== 'portal') {
      next = unwrap(await bridge.saveSecret(route, secret));
      setSecret('');
    }
    update(next);
    return next;
  }
  return <div className={`connection-settings ${connection ? 'configuration-connection' : ''}`}>
    <form className="settings-card settings-form" onSubmit={event => { event.preventDefault(); void act(async () => { await persist(); setNotice('Settings saved.'); }); }}>
      {connection && route !== 'portal' && <>
        {route === 'byok' && <SettingRow title="Provider"><SettingsSelect id="provider" aria-label="Provider" value={draft.byok.provider} disabled={busy} onChange={event => {
          const provider = event.target.value as SettingsType['byok']['provider'];
          setDraft({ ...draft, byok: { ...draft.byok, provider, ...providerPresets[provider], model: '', contextWindowTokens: undefined, maxOutputTokens: undefined, modelCapabilities: undefined, reasoningOverride: undefined } }); setSecret(''); setReport(null);
        }}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="xai">xAI</option><option value="openrouter">OpenRouter</option><option value="custom">Custom provider</option></SettingsSelect></SettingRow>}
        <SettingRow title={route === 'local' ? 'Local server address' : 'API address'} description={route === 'local' ? 'Use your server’s OpenAI-compatible /v1 address.' : undefined}>
          <Input id="endpoint" aria-label={route === 'local' ? 'Local server address' : 'API address'} disabled={busy} value={draft[route].endpoint} onChange={event => { setDraft({ ...draft, [route]: { ...draft[route], endpoint: event.target.value, contextWindowTokens: undefined, modelCapabilities: undefined, reasoningOverride: undefined } }); setReport(null); }} />
        </SettingRow>
        {route === 'byok' && (draft.byok.provider === 'custom' || draft.byok.provider === 'openai') && <SettingRow title="API format"><SettingsSelect id="protocol" aria-label="API format" disabled={busy} value={draft.byok.protocol} onChange={event => { setDraft({ ...draft, byok: { ...draft.byok, protocol: event.target.value as SettingsType['byok']['protocol'], modelCapabilities: undefined, reasoningOverride: undefined } }); setReport(null); }}><option value="openai-compatible">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic">Anthropic</option></SettingsSelect></SettingRow>}
        <SettingRow title="Model"><Input id="model" aria-label="Model" list="available-models" disabled={busy} value={draft[route].model} placeholder="Enter a model ID" onChange={event => { setDraft({ ...draft, [route]: { ...draft[route], model: event.target.value, contextWindowTokens: undefined, modelCapabilities: undefined, reasoningOverride: undefined } }); setReport(null); }} /><datalist id="available-models">{report?.models.map(model => <option key={model} value={model} />)}</datalist></SettingRow>
        <SettingRow title={route === 'local' ? 'Server key (optional)' : 'API key'} description="Stored with your operating system’s encryption."><div className="configuration-key"><Input id="api-key" aria-label={route === 'local' ? 'Server key (optional)' : 'API key'} type="password" autoComplete="off" spellCheck={false} disabled={busy || !snapshot.secureStorageAvailable} value={secret} placeholder={snapshot.secrets[route] ? 'Saved key · enter to replace' : 'Enter your key'} onChange={event => setSecret(event.target.value)} />
          {snapshot.secrets[route] && <Button variant="ghost" size="icon" type="button" aria-label="Remove saved key" disabled={busy} onClick={() => void act(async () => { update(unwrap(await bridge.deleteSecret(route))); setSecret(''); setReport(null); setNotice('Saved key removed.'); })}><Trash2 /></Button>}</div>
        </SettingRow>
        {route === 'byok' && <p className="configuration-credential-note">Changing the provider, API format, or address removes its saved key.</p>}
        {!snapshot.secureStorageAvailable && <p className="text-sm text-destructive">Secure credential storage is unavailable on this computer.</p>}
        <SettingRow title="Tools" description="Enable for models that support tool calling."><Switch disabled={busy} label="Enable tools for this connection" value={draft[route].tools} change={value => { if (!busy) setDraft({ ...draft, [route]: { ...draft[route], tools: value } }); }} /></SettingRow>
        <SettingRow title="Direct image input" description="Built-in image understanding works through tools. Enable this only for models that also accept images directly."><Switch disabled={busy} label="This model supports image input" value={draft[route].images} change={value => { if (!busy) setDraft({ ...draft, [route]: { ...draft[route], images: value } }); }} /></SettingRow>
        <details className="configuration-advanced"><summary>Advanced conversation settings</summary>
          <SettingRow title="Reasoning controls" description="Automatic uses model capabilities. For a custom or local server, choose only a format supported by your selected model."><SettingsSelect aria-label="Reasoning controls" value={draft[route].reasoningOverride?.kind ?? 'auto'} disabled={busy} onChange={event => {
            const kind = event.target.value as ReasoningProfile['kind'] | 'auto';
            const profile: ReasoningProfile | undefined = kind === 'auto' ? undefined : { kind, efforts: kind === 'none' ? [] : ['low', 'medium', 'high'], canDisable: kind !== 'none', ...(kind === 'anthropic-budget' ? { tokenBudget: true } : {}) };
            setDraft({ ...draft, [route]: { ...draft[route], reasoningOverride: profile } });
          }}><option value="auto">Automatic</option><option value="none">No native control</option>{(route === 'local' || draft.byok.protocol !== 'anthropic') && <><option value="openai">OpenAI effort</option><option value="openrouter">OpenRouter reasoning</option><option value="ollama">Ollama thinking</option><option value="llamacpp">llama.cpp template</option></>}{route === 'byok' && draft.byok.protocol === 'anthropic' && <><option value="anthropic-adaptive">Claude adaptive thinking</option><option value="anthropic-budget">Claude thinking budget</option></>}</SettingsSelect></SettingRow>
          {draft[route].reasoningOverride && draft[route].reasoningOverride.kind !== 'none' && <SettingRow title="Reasoning can be disabled" description="Turn off for models that require reasoning. Instant then uses the lowest supported effort."><Switch disabled={busy} label="Reasoning can be disabled" value={draft[route].reasoningOverride.canDisable} change={value => setDraft({ ...draft, [route]: { ...draft[route], reasoningOverride: { ...draft[route].reasoningOverride!, canDisable: value } } })} /></SettingRow>}
          <SettingRow title="Model conversation capacity" description="Use the capacity configured in your server. Leave blank for automatic."><Input id="conversation-capacity" aria-label="Model conversation capacity" type="number" min={4096} max={2000000} step={1} disabled={busy} value={draft[route].contextWindowTokens ?? ''} placeholder="Automatic" onChange={event => setDraft({ ...draft, [route]: { ...draft[route], contextWindowTokens: event.target.value ? Number(event.target.value) : undefined } })} /></SettingRow>
          <SettingRow title="Maximum output tokens" description="The budget for each response, including reasoning and tool arguments."><Input id="maximum-output-tokens" aria-label="Maximum output tokens" type="number" min={128} max={128000} step={1} disabled={busy} value={draft[route].maxOutputTokens ?? ''} placeholder="Automatic" onChange={event => setDraft({ ...draft, [route]: { ...draft[route], maxOutputTokens: event.target.value ? Number(event.target.value) : undefined } })} /></SettingRow>
        </details>
      </>}
      {section === 'Browser' && <div className="space-y-2"><label htmlFor="default-search-engine" className="text-sm font-medium">Default search engine</label><SettingsSelect id="default-search-engine" className="control" disabled={busy} value={draft.browser.engine} onChange={event => setDraft({ ...draft, browser: { ...draft.browser, engine: event.target.value as SettingsType['browser']['engine'] } })}><option value="google">Google</option><option value="bing">Bing</option><option value="brave">Brave</option><option value="duckduckgo">DuckDuckGo</option></SettingsSelect><p className="text-xs leading-5 text-muted-foreground">Search, browser interaction, and page extraction use Chromium included in TinyGPT. No separate search server is required.</p></div>}
      {section === 'General' && <div>
        <h2 className="text-base font-semibold">Tool approvals</h2>
        <p className="mb-4 mt-2 text-xs leading-5 text-muted-foreground">Choose what your assistant may do automatically. File tools stay in the Project folder. Page reading and browser interaction have separate approvals. Commands, messaging, and purchases are not connected yet.</p>
        <div className="space-y-3">{(Object.keys(draft.toolPermissions) as (keyof ToolPermissions)[]).map(operation => <div key={operation} className="flex items-center justify-between gap-4">
          <label htmlFor={`approval-${operation}`} className="text-sm">{{ read: 'Read files and saved sources', write: 'Change files', execute: 'Run commands', browser: 'Search and read pages', interact: 'Interact with websites', desktop: 'Read desktop windows', desktopInteract: 'Control desktop windows', send: 'Send messages', purchase: 'Make purchases' }[operation]}</label>
          <SettingsSelect id={`approval-${operation}`} className="control max-w-44" disabled={busy} value={draft.toolPermissions[operation]} onChange={event => setDraft({ ...draft, toolPermissions: { ...draft.toolPermissions, [operation]: event.target.value as ApprovalRule } })}><option value="ask">Ask me first</option><option value="allow">Allow automatically</option><option value="deny">Never allow</option></SettingsSelect>
        </div>)}</div>
      </div>
      }
      <div className="flex gap-3 pt-2"><Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Check />}Save settings</Button>
        {connection && route !== 'portal' && <Button type="button" disabled={busy} onClick={() => void act(async () => {
          await persist(); const checked = unwrap(await bridge.checkConnection(route)); setReport(checked);
          const selected = checked.modelDetails?.find(model => model.id === draft[route].model);
          const next = { ...draft, [route]: { ...draft[route], contextWindowTokens: draft[route].contextWindowTokens ?? checked.modelContextWindowTokens, modelCapabilities: selected?.reasoning ? { model: selected.id, images: selected.images, reasoning: selected.reasoning } : undefined } }; setDraft(next); update(unwrap(await bridge.saveSettings(settingsSchema.parse(next))));
        })}><PlugZap />Save & check connection</Button>}
      </div>
      <div aria-live="polite">
        {notice && <p className="text-sm">{notice}</p>}
        {report && <p className={`text-sm ${report.reachable ? '' : 'text-destructive'}`}>{report.message} {report.models.length > 0 && `${report.models.length} ${report.models.length === 1 ? 'model' : 'models'} listed.`}</p>}
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </form>
  </div>;
}

