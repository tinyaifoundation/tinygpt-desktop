import { useEffect, useState } from 'react';
import type { DesktopBridge } from '../../shared/contracts';
import type { UpdateState } from '../../shared/updates';
import { ArrowUp, LoaderCircle } from '../icons';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import './app-update.css';

export function AppUpdate({ bridge, settings = false }: { bridge: DesktopBridge; settings?: boolean }) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!bridge.updates || !bridge.onUpdateState) return;
    let alive = true;
    const unsubscribe = bridge.onUpdateState(value => { if (alive) setState(value); });
    void bridge.updates().then(result => { if (alive && result.ok) setState(result.value); });
    return () => { alive = false; unsubscribe(); };
  }, [bridge]);
  if (!state || (!settings && !['available', 'downloading', 'ready'].includes(state.phase) && !(state.phase === 'error' && state.version))) return null;
  const waiting = busy || state.phase === 'checking' || state.phase === 'downloading';
  const action = state.phase === 'available' ? 'download' : state.phase === 'ready' ? 'install' : 'check';
  const label = state.phase === 'ready' ? 'Restart to update' : state.phase === 'downloading' ? `Downloading ${Math.floor(state.percent ?? 0)}%` : state.phase === 'available' ? 'Download update' : state.phase === 'checking' ? 'Checking…' : 'Check for updates';
  const perform = async () => {
    setBusy(true);
    try { const result = await bridge.updateAction!(action); if (result.ok) setState(result.value); else setState({ ...state, message: result.error }); }
    catch { setState({ ...state, message: 'Updates could not be checked. Try again.' }); }
    finally { setBusy(false); }
  };
  if (settings) return <div className="app-update-settings"><span>{state.message || (state.phase === 'unavailable' ? 'Updates are unavailable in this build.' : `TinyGPT ${state.currentVersion}`)}</span><button type="button" disabled={waiting || state.phase === 'unavailable'} onClick={() => void perform()}>{label}</button></div>;
  return <Popover><PopoverTrigger asChild><button type="button" className="sidebar-app-update" aria-label={state.phase === 'ready' ? 'Update ready to install' : 'TinyGPT update available'}>{state.phase === 'downloading' ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}<span>{state.phase === 'ready' ? 'Ready to update' : state.phase === 'downloading' ? label : 'Update available'}</span><i aria-hidden="true" /></button></PopoverTrigger><PopoverContent side="right" align="end" className="app-update-panel"><strong>{state.phase === 'ready' ? 'Ready when you are' : 'A new TinyGPT is here'}</strong><small>{state.version}</small>{state.notes && <p className="app-update-notes">{state.notes}</p>}{state.phase === 'downloading' && <progress max={100} value={state.percent ?? 0} aria-label="Update download progress" />}{state.message && <p role="status">{state.message}</p>}<button type="button" disabled={waiting} onClick={() => void perform()}>{label}</button></PopoverContent></Popover>;
}
