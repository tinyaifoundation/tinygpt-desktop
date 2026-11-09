import { useEffect, useRef, useState } from 'react';
import type { AppSnapshot, DesktopBridge } from '../../shared/contracts';
import type { ManagedLocalStatus } from '../../shared/managed-local';
import { builtInModelId } from '../../shared/managed-local';
import { ArrowLeft, ArrowRight, Check, Globe, LoaderCircle, Monitor, ShieldCheck, Volume2 } from '../icons';
import { Switch } from './AppearanceSettings';
import { RobotAvatar } from './RobotAvatar';
import { OnboardingShowcase } from './OnboardingShowcase';
import { profileNames, type Profile } from '../lib/appearance';
import { saveWelcomeProfile } from '../lib/onboarding-profile';

const steps = [
  { title: 'Your private AI companion for every idea', subtitle: 'Think, create, and get things done with a companion that lives on your computer.', label: 'Your companion' },
  { title: 'Ask anything, anytime.', subtitle: 'Free forever with the included local model. No account or subscription required.', label: 'Free forever' },
  { title: 'Tailored to you', subtitle: 'A name, a few preferences, a little context. Keep the memories you choose, stored 100% locally.', label: 'Memories' },
  { title: 'More than just text', subtitle: 'Work through a project, write code, explore documents, or use your voice.', label: 'Work and voice' },
];
const starters = ['Help me think through an idea', 'Explain something simply', 'Show me what TinyGPT can do'];

export function Onboarding({ snapshot, bridge, update, done, profile, changeProfile }: {
  snapshot: AppSnapshot; bridge: DesktopBridge; update: (value: AppSnapshot) => void; done: (prompt?: string) => void; profile: Profile; changeProfile: (value: Profile) => void;
}) {
  const step = snapshot.onboarding?.step ?? 0;
  const current = steps[step];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [local, setLocal] = useState<ManagedLocalStatus>();
  const [starter, setStarter] = useState<string>();
  const [firstName, setFirstName] = useState(() => profileNames(profile).firstName);
  const lock = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [step]);
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try { const result = await bridge.builtInStatus(); if (alive && result.ok) setLocal(result.value.included); }
      catch { /* A missing status is never presented as ready. */ }
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
  async function progress(nextStep: number, status: 'in-progress' | 'completed' | 'skipped' = 'in-progress') {
    if (step === 2 && nextStep === 3 && status === 'in-progress') {
      const saved = await saveWelcomeProfile(bridge, profile, firstName);
      if (saved !== profile) changeProfile(saved);
    }
    const result = await bridge.saveOnboarding({ version: 1, step: nextStep, status });
    if (!result.ok) throw new Error(result.error);
    update(result.value);
    if (status !== 'in-progress') done(status === 'completed' ? starter : undefined);
  }
  const selectedLocal = snapshot.settings.route === 'local' && builtInModelId(snapshot.settings.local.model) === 'included';
  const selectedCloud = snapshot.settings.route === 'byok' && snapshot.settings.byok.provider === 'openrouter' && !!snapshot.secrets.byok;
  const localLabel = local?.phase === 'running' ? selectedLocal ? 'Active on this device' : 'Running on this device' : local?.phase === 'starting' ? 'Getting ready…' : local?.phase === 'error' ? 'Needs attention' : local?.ready ? 'Installed on this device' : 'Checking your device…';
  return <main className="onboarding" aria-label="Welcome to TinyGPT" aria-busy={busy}>
    <OnboardingShowcase step={step} />
    <div className="onboarding-panel">
    <header className="onboarding-header"><button type="button" className="onboarding-skip" disabled={busy} onClick={() => void act(() => progress(step, 'skipped'))}>Set up later</button></header>
    <div className="onboarding-body" key={step}>
      <div className="onboarding-copy"><h1 ref={heading} tabIndex={-1}>{current.title}</h1><p>{current.subtitle}</p></div>
      <div className="onboarding-detail">
        {step === 1 && <><div className="onboarding-models">
          <button type="button" className="onboarding-choice" aria-pressed={selectedLocal} disabled={busy} onClick={() => void act(async () => { const result = await bridge.startBuiltInModel('included'); if (!result.ok) throw new Error(result.error); update(result.value); const state = await bridge.builtInStatus(); if (state.ok) setLocal(state.value.included); })}><Monitor /><span><strong>On this device <small>Free forever</small></strong><span>No account. Works offline.</span><em className={local?.phase === 'running' ? 'is-ready' : ''}>{local?.phase === 'running' && <i />}{localLabel}</em></span>{selectedLocal && <Check className="onboarding-selected" />}</button>
        </div>{local?.phase === 'error' && selectedLocal && <p className="onboarding-note">The included model couldn’t start. You can continue and check Configuration.</p>}
        <button type="button" className="onboarding-cloud-link" disabled={busy} onClick={() => void act(async () => { const result = await bridge.connectOpenRouter(); if (!result.ok) throw new Error(result.error); update(result.value); })}><Globe />{selectedCloud ? 'OpenRouter connected' : 'Optional: connect OpenRouter'}</button><p className="onboarding-cloud-note">External model providers may charge for usage.</p></>}
        {step === 2 && <><label className="onboarding-name-field">Your first name (optional)<input autoComplete="given-name" value={firstName} maxLength={60} placeholder="What should we call you?" disabled={busy} onChange={event => setFirstName(event.target.value)} /></label><p className="onboarding-name-hint">Continue to save it to your profile and personal memory. Leave blank to skip. Manage sharing in Personalization.</p><div className="onboarding-memory-note"><ShieldCheck /><div><strong>100% local storage</strong><p>Your name and memories stay on this computer. You choose what to save or forget. If you use a cloud model, relevant memories may be sent with your request.</p></div></div></>}
        {step === 3 && <><div className="onboarding-preference"><Volume2 /><span><strong>Read replies aloud</strong><span>A voice for your conversations.</span></span><Switch label="Read replies aloud" value={snapshot.settings.voice.readAloud.enabled} disabled={busy} change={enabled => void act(async () => { const fresh = await bridge.snapshot(); if (!fresh.ok) throw new Error(fresh.error); const settings = fresh.value.settings; const result = await bridge.saveSettings({ ...settings, voice: { ...settings.voice, readAloud: { ...settings.voice.readAloud, enabled } } }); if (!result.ok) throw new Error(result.error); update(result.value); })} /></div><div className="onboarding-starters" aria-label="Choose a first conversation">{starters.map(prompt => <button key={prompt} type="button" aria-pressed={starter === prompt} onClick={() => setStarter(starter === prompt ? undefined : prompt)}>{prompt}{starter === prompt ? <Check /> : <ArrowRight />}</button>)}</div><div className="onboarding-ready"><RobotAvatar size={25} /><span>{selectedCloud ? 'Your connected model is selected.' : selectedLocal ? local?.phase === 'running' ? 'TinyGPT is ready on this device.' : 'Your local model is selected. Check Configuration if it needs attention.' : 'Your current model selection is preserved.'}</span></div></>}
      </div>
    </div>
    <footer className="onboarding-footer"><div className="onboarding-footer-side">{step > 0 && <button type="button" className="onboarding-back" disabled={busy} onClick={() => void act(() => progress(step - 1))}><ArrowLeft />Back</button>}</div><nav className="onboarding-progress" aria-label="Welcome progress">{steps.map((item, index) => <span key={item.label} aria-current={step === index ? 'step' : undefined} aria-label={`${item.label}, step ${index + 1} of 4`} />)}</nav><div className="onboarding-footer-side"><button type="button" className="onboarding-next" disabled={busy} onClick={() => void act(() => step === 3 ? progress(step, 'completed') : progress(step + 1))}>{busy ? <LoaderCircle className="animate-spin" /> : <>{step === 0 ? 'Get started' : step === 3 ? 'Open TinyGPT' : 'Continue'}<ArrowRight /></>}</button></div></footer>
    {error && <div className="onboarding-error" role="alert">{error}</div>}
    </div>
  </main>;
}
