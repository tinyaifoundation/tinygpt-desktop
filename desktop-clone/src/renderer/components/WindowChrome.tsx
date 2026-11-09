import { useEffect, useState, type PointerEvent } from 'react';
import { Minus, Square, Copy, X } from '../icons';
import type { DesktopBridge, ResizeEdge, WindowState } from '../../shared/contracts';
import { ControlTooltip, TooltipProvider } from './ui/tooltip';

export function WindowChrome({ bridge, platform, changed, reportError }: { bridge: DesktopBridge; platform: string; changed: (state: WindowState) => void; reportError: (error: string) => void }) {
  const [state, setState] = useState<WindowState>({ maximized: false, fullScreen: false });
  useEffect(() => {
    const sync = (next: WindowState) => { setState(next); changed(next); };
    const unsubscribe = bridge.onWindowState(sync);
    void bridge.windowState().then(result => { if (result.ok) sync(result.value); });
    return unsubscribe;
  }, [bridge, changed]);
  const commands = [
    { action: 'minimize', label: 'Minimize window', Icon: Minus },
    { action: 'maximize', label: state.maximized || state.fullScreen ? 'Restore window' : 'Maximize window', Icon: state.maximized ? Copy : Square },
    { action: 'close', label: 'Close window', Icon: X },
  ] as const;
  const controls = platform === 'darwin' ? [commands[2], commands[0], commands[1]] : commands;
  function resize(event: PointerEvent, edge: ResizeEdge, phase: 'start' | 'move' | 'end') {
    if (phase === 'move' && !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    if (phase === 'start') event.currentTarget.setPointerCapture(event.pointerId);
    void bridge.resizeWindow({ edge, phase, x: event.screenX, y: event.screenY });
    if (phase === 'end' && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return <TooltipProvider><div className={`window-controls ${platform === 'darwin' ? 'is-mac' : 'is-windows'}`} aria-label="Window controls">
    {controls.map(({ action, label, Icon }) => <ControlTooltip label={label} key={action}><button type="button" className={`window-control window-${action}`} aria-label={label} onClick={() => { void bridge.windowControl(action).then(result => { if (!result.ok) reportError(result.error); }); }}><span><Icon /></span></button></ControlTooltip>)}
  </div>{!state.maximized && !state.fullScreen && (['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const).map(edge => <div key={edge} aria-hidden="true" className={`window-resize resize-${edge}`} onPointerDown={event => resize(event, edge, 'start')} onPointerMove={event => resize(event, edge, 'move')} onPointerUp={event => resize(event, edge, 'end')} onPointerCancel={event => resize(event, edge, 'end')} />)}</TooltipProvider>;
}
