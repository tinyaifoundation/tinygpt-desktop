import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppSnapshot, DesktopBridge } from '../../shared/contracts';
import { builtInModelId, builtInModels, type BuiltInHardware, type BuiltInModelId, type ManagedLocalStatus } from '../../shared/managed-local';
import { ArrowLeft, ArrowRight, Check, LoaderCircle, Moon, ShieldCheck, Sun, Volume2 } from '../icons';
import { Switch } from './AppearanceSettings';
import { OnboardingShowcase } from './OnboardingShowcase';
import { BuiltInModal } from './ConfigurationSettings';
import { Dialog } from './ui/dialog';
import { TooltipProvider } from './ui/tooltip';
import { profileNames, type Appearance, type Profile } from '../lib/appearance';
import { defaultBotDesign, type BotDesign } from '../lib/bot';
import { saveWelcomeProfile } from '../lib/onboarding-profile';
import openRouterLogo from '../assets/inference/openrouter.svg';

const steps = [
  { title: 'Your private AI companion for every idea', subtitle: 'Your ideas. Your device. A little help along the way.', label: 'Your companion' },
  { title: 'Ask anything, anytime.', subtitle: 'Free forever. Your on-device AI is already included.', label: 'Free forever' },
  { title: 'Tailored to you', subtitle: 'A little context. A more personal companion.', label: 'Memories' },
  { title: 'Meet your Bot', subtitle: 'A sidekick with a personality of its own.', label: 'Your Bot' },
  { title: 'More than just text', subtitle: 'Work, code, documents, and voice. Make something happen.', label: 'Work and voice' },
];
const starters = ['Help me think through an idea', 'Explain something simply', 'Show me what TinyGPT can do'];
type BotSetupControls = { close: () => void; complete: () => void; busyChanged: (busy: boolean) => void };

export function Onboarding({ snapshot, bridge, update, done, profile, changeProfile, appearance, changeAppearance, bot = defaultBotDesign, botConfigured = false, renderBotSetup }: {
  snapshot: AppSnapshot; bridge: DesktopBridge; update: (value: AppSnapshot) => void; done: (prompt?: string) => void;
  profile: Profile; changeProfile: (value: Profile) => void; appearance: Appearance; changeAppearance: (value: Appearance) => void;
  bot?: BotDesign; botConfigured?: boolean; renderBotSetup?: (controls: BotSetupControls) => ReactNode;
}) {
  const step = snapshot.onboarding?.step ?? 0, current = steps[step];
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [models, setModels] = useState<Partial<Record<BuiltInModelId, ManagedLocalStatus>>>({});
  const [hardware, setHardware] = useState<BuiltInHardware>();
  const [proOpen, setProOpen] = useState(false), [botOpen, setBotOpen] = useState(false), [botBusy, setBotBusy] = useState(false);
  const [starter, setStarter] = useState<string>();
  const [firstName, setFirstName] = useState(() => profileNames(profile).firstName);
  const lock = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); setError(''); }, [step]);
  useEffect(() => {
    let alive = true;
    void bridge.builtInHardware().then(result => { if (alive && result.ok) setHardware(result.value); }).catch(() => {});
    const refresh = async () => {
      try { const result = await bridge.builtInStatus(); if (alive && result.ok) setModels(result.value); }
      catch { /* Unknown model status never blocks welcome or grants Pro eligibility. */ }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 2500);
    return () => { alive = false; clearInterval(timer); };
  }, [bridge]);
  async function act(operation: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await operation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'That could not be saved. Please try again.'); }
    finally { lock.current = false; setBusy(false); }
  }
  async function progress(nextStep: number, status: 'in-progress' | 'completed' | 'skipped' = 'in-progress', skipName = false) {
    if (step === 2 && nextStep === 3 && status === 'in-progress' && !skipName) {
      const saved = await saveWelcomeProfile(bridge, profile, firstName);
      if (saved !== profile) changeProfile(saved);
    }
    const result = await bridge.saveOnboarding({ version: 2, step: nextStep, status });
    if (!result.ok) throw new Error(result.error);
    update(result.value);
    if (status !== 'in-progress') done(status === 'completed' ? starter : undefined);
  }
  const selectedCloud = snapshot.settings.route === 'byok' && snapshot.settings.byok.provider === 'openrouter' && !!snapshot.secrets.byok;
  const connectedCloud = selectedCloud || !!snapshot.inferenceConnections?.some(connection => connection.route === 'byok' && connection.config.provider === 'openrouter' && connection.connected);
  const selectedPro = snapshot.settings.route === 'local' && builtInModelId(snapshot.settings.local.model) === 'pro';
  const proSize = ((builtInModels.pro.downloadBytes + (snapshot.settings.builtIn?.proMtp !== false ? builtInModels.pro.predictionBytes : 0)) / 1e9).toFixed(1);
  const theme = appearance.theme === 'system' ? document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light' : appearance.theme;
  const nextLabel = step === 0 ? 'Get started' : step === 4 ? 'Open TinyGPT' : (step === 1 && !selectedPro && !connectedCloud) || (step === 2 && !firstName.trim()) || (step === 3 && !botConfigured) ? 'Add later' : 'Continue';
  return <TooltipProvider><main className="onboarding" data-theme={theme} aria-label="Welcome to TinyGPT" aria-busy={busy}>
    <div className="onboarding-window-drag" aria-hidden="true" />
    <OnboardingShowcase step={step} bot={bot} />
    <div className="onboarding-panel">
      <header className="onboarding-header"><button type="button" className="onboarding-skip" disabled={busy} onClick={() => void act(() => progress(step, 'skipped'))}>Set up later</button></header>
      <div className="onboarding-body" key={step}>
        <div className="onboarding-copy"><h1 ref={heading} tabIndex={-1}>{current.title}</h1><p>{current.subtitle}</p></div>
        <div className="onboarding-detail">
          {step === 0 && <div className="onboarding-themes" role="radiogroup" aria-label="Appearance" onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); const next = event.key === 'Home' ? 'light' : event.key === 'End' ? 'dark' : theme === 'light' ? 'dark' : 'light';
            changeAppearance({ ...appearance, theme: next }); event.currentTarget.querySelector<HTMLButtonElement>(`[data-theme-choice="${next}"]`)?.focus();
          }}>{(['light', 'dark'] as const).map(value => <button type="button" role="radio" data-theme-choice={value} aria-checked={theme === value} tabIndex={theme === value ? 0 : -1} key={value} onClick={() => changeAppearance({ ...appearance, theme: value })}>{value === 'light' ? <Sun /> : <Moon />}{value === 'light' ? 'Light' : 'Dark'}</button>)}</div>}
          {step === 1 && <><p className="onboarding-optional-label">Optional extras</p><div className="onboarding-options">
            {hardware?.proCompatible === true && <div className="onboarding-option"><span className="onboarding-pro-icon">Pro</span><div><strong>TinyGPT Pro</strong><p>{selectedPro ? 'Selected on this device' : `${proSize} GB download · runs locally`}</p></div><button type="button" disabled={busy} onClick={() => setProOpen(true)}>{selectedPro ? 'Manage' : 'Set up'}</button></div>}
            <div className="onboarding-option"><img src={openRouterLogo} className="onboarding-openrouter-logo" alt="" /><div><strong>OpenRouter</strong><p>Cloud models. Usage may cost extra.</p></div><button type="button" disabled={busy || connectedCloud} onClick={() => void act(async () => { const result = await bridge.connectOpenRouter(); if (!result.ok) throw new Error(result.error); update(result.value); })}>{connectedCloud ? <><Check />Connected</> : 'Connect'}</button></div>
          </div><p className="onboarding-later-hint">Add these anytime in Configuration.</p></>}
          {step === 2 && <><label className="onboarding-name-field">Your first name (optional)<input autoComplete="given-name" value={firstName} maxLength={60} placeholder="What should we call you?" disabled={busy} onChange={event => setFirstName(event.target.value)} /></label><p className="onboarding-name-hint">Save to your profile and personal memory. Manage sharing in Personalization.</p><div className="onboarding-memory-note"><ShieldCheck /><div><strong>100% local storage</strong><p>You choose what to remember. Cloud models may receive relevant memories with your request.</p></div></div><button type="button" className="onboarding-text-action" disabled={busy} onClick={() => void act(() => progress(3, 'in-progress', true))}>Skip this step</button></>}
          {step === 3 && <div className="onboarding-bot-choice"><div className="onboarding-bot-traits"><span>Make it yours</span><span>Give it a task</span><span>Keep in touch</span></div>{botConfigured ? <p className="onboarding-later-hint"><Check />Your Bot is set up.</p> : <><button type="button" className="onboarding-setup-bot" disabled={busy || !renderBotSetup} onClick={() => setBotOpen(true)}>Set up now<ArrowRight /></button><p className="onboarding-later-hint">Or add your Bot later from the sidebar.</p></>}</div>}
          {step === 4 && <><div className="onboarding-preference"><Volume2 /><span><strong>Read replies aloud</strong><span>A voice for your conversations.</span></span><Switch label="Read replies aloud" value={snapshot.settings.voice.readAloud.enabled} disabled={busy} change={enabled => void act(async () => { const fresh = await bridge.snapshot(); if (!fresh.ok) throw new Error(fresh.error); const settings = fresh.value.settings; const result = await bridge.saveSettings({ ...settings, voice: { ...settings.voice, readAloud: { ...settings.voice.readAloud, enabled } } }); if (!result.ok) throw new Error(result.error); update(result.value); })} /></div><div className="onboarding-starters" aria-label="Choose a first conversation">{starters.map(prompt => <button type="button" key={prompt} aria-pressed={starter === prompt} onClick={() => setStarter(starter === prompt ? undefined : prompt)}>{prompt}{starter === prompt ? <Check /> : <ArrowRight />}</button>)}</div></>}
        </div>
      </div>
      <footer className="onboarding-footer"><div className="onboarding-footer-side">{step > 0 && <button type="button" className="onboarding-back" disabled={busy} onClick={() => void act(() => progress(step - 1))}><ArrowLeft />Back</button>}</div><nav className="onboarding-progress" aria-label="Welcome progress">{steps.map((item, index) => <span key={item.label} aria-current={step === index ? 'step' : undefined} aria-label={`${item.label}, step ${index + 1} of ${steps.length}`} />)}</nav><div className="onboarding-footer-side"><button type="button" className="onboarding-next" disabled={busy} onClick={() => void act(() => step === 4 ? progress(step, 'completed') : progress(step + 1))}>{busy ? <LoaderCircle className="animate-spin" /> : <>{nextLabel}<ArrowRight /></>}</button></div></footer>
      {error && <div className="onboarding-error" role="alert">{error}</div>}
    </div>
    {proOpen && <BuiltInModal id="pro" status={models.pro} snapshot={snapshot} bridge={bridge} update={update} close={() => setProOpen(false)} restoreIncludedOnFailure />}
    <Dialog open={botOpen} change={open => { if (!botBusy) setBotOpen(open); }} title="Set up your Bot" titleHidden className="onboarding-bot-dialog" closeDisabled={botBusy}>{botOpen && renderBotSetup?.({ close: () => { if (!botBusy) setBotOpen(false); }, busyChanged: setBotBusy, complete: () => { setBotBusy(false); setBotOpen(false); void act(() => progress(4)); } })}</Dialog>
  </main></TooltipProvider>;
}
