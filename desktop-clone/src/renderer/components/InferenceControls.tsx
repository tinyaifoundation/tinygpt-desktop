import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { SlidersHorizontal, Check, ChevronDown, Gauge, Loader2, Search, Settings2, Zap } from '../icons';
import type { AppSnapshot, DesktopBridge, Result } from '../../shared/contracts';
import type { Settings } from '../../shared/config';
import type { InferenceConnection } from '../../shared/inference-connections';
import { InferenceProviderIcon } from './InferenceProviderIcon';
import { effortLabel, effortLevels, modelDisplayName, type Effort, type ModelInfo } from '../../shared/effort';
import { builtInModelId, builtInModels, type BuiltInModelId, type ManagedLocalStatus } from '../../shared/managed-local';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { ControlTooltip, Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

export function useComposerInference(snapshot: AppSnapshot, bridge: DesktopBridge, update: (value: AppSnapshot) => void, reportError: (message: string) => void) {
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState<{ connectionId: string; model: string; name: string; builtIn?: BuiltInModelId }>();
  const [switchingText, setSwitchingText] = useState('Switching model…');
  const [switchError, setSwitchError] = useState<{ connectionId: string; model: string }>();
  const saving = useRef(false);
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const settings = snapshot.settings;
  const route = settings.route;
  const config = route === 'portal' ? undefined : settings[route];
  const model = config?.model ?? '';
  const openrouter = route === 'byok' && settings.byok.provider === 'openrouter';
  const savedName = config?.modelCapabilities?.model === model ? config.modelCapabilities.name?.trim() : undefined;
  const identity = JSON.stringify([route, config?.endpoint, route === 'byok' && settings.byok.provider, route === 'byok' && settings.byok.protocol, model, snapshot.secrets[route], settings.openrouter.access, settings.openrouter.zeroDataRetention]);
  const [discoveredName, setDiscoveredName] = useState<{ identity: string; name: string }>();
  useEffect(() => {
    // Existing selections may predate catalog names. Resolve these without
    // opening a picker, changing inference preferences, or blocking the composer.
    if (!openrouter || !model || savedName || !snapshot.secrets.byok) return;
    let current = true;
    void bridge.checkConnection('byok').then(result => {
      const name = result.ok ? result.value.modelDetails?.find(item => item.id === model)?.name?.trim() : undefined;
      if (current && name) setDiscoveredName({ identity, name });
    }, () => {});
    return () => { current = false; };
  }, [bridge, identity, savedName, openrouter, model]);
  const modelName = modelDisplayName({ id: model, name: savedName ?? (discoveredName?.identity === identity ? discoveredName.name : undefined) }, openrouter);
  useEffect(() => {
    if (!switching?.builtIn) return;
    let current = true, timer: ReturnType<typeof setTimeout> | undefined;
    const id = switching.builtIn;
    const poll = async () => {
      try {
        const result = await bridge.builtInStatus();
        if (current && result.ok) {
          const status = result.value[id], other = result.value[id === 'pro' ? 'included' : 'pro'];
          const messages: Record<ManagedLocalStatus['phase'], string> = { idle: 'Getting ready…', stopping: 'Switching models…', downloading: 'Downloading model…', verifying: 'Checking files…', extracting: 'Preparing model…', starting: 'Loading model…', running: 'Almost ready…', error: 'Couldn’t load model…' };
          const percent = status.phase === 'downloading' && status.total && typeof status.downloaded === 'number' ? ` ${Math.min(100, Math.floor(status.downloaded / status.total * 100))}%` : '';
          setSwitchingText(other.phase === 'stopping' ? 'Switching models…' : messages[status.phase] + percent);
        }
      } catch { /* The switching request owns success/failure; polling is optional. */ }
      finally { if (current) timer = setTimeout(() => void poll(), 500); }
    };
    void poll();
    return () => { current = false; clearTimeout(timer); };
  }, [bridge, switching?.builtIn]);
  async function commit(operation: () => Promise<Result<AppSnapshot>>) {
    if (saving.current) return false;
    saving.current = true; setBusy(true);
    try { const result = await operation(); if (!result.ok) throw Error(result.error); latest.current = result.value; update(result.value); return true; }
    catch (error) { reportError(error instanceof Error ? error.message : 'The inference settings could not be saved.'); return false; }
    finally { saving.current = false; setBusy(false); }
  }
  const save = (change: (settings: Settings) => Settings) => commit(() => bridge.saveSettings(change(latest.current.settings)));
  const chooseModel = (route: 'byok' | 'local', id: string, endpoint: string) => commit(() => route === 'local' ? bridge.useLocalModel(endpoint, id) : bridge.chooseOpenRouterModel(id));
  async function chooseConnectionModel(connectionId: string, model: string, name?: string) {
    if (saving.current) return false;
    const connection = latest.current.inferenceConnections?.find(item => item.id === connectionId);
    const builtIn = connection?.route === 'local' ? builtInModelId(model) : undefined;
    setSwitchError(undefined); setSwitchingText(builtIn ? 'Getting ready…' : 'Switching model…');
    setSwitching({ connectionId, model, name: builtIn ? builtInModels[builtIn].name : name || model, builtIn });
    try {
      const success = await commit(() => bridge.chooseConnectionModel(connectionId, model));
      if (!success) setSwitchError({ connectionId, model });
      return success;
    } finally { setSwitching(undefined); }
  }
  return { snapshot, bridge, busy, switching, switchingText, switchError, save, chooseModel, chooseConnectionModel, modelName };
}
type Controller = ReturnType<typeof useComposerInference>;

export function ComposerModelPicker({ controller, disabled, openSettings }: { controller: Controller; disabled: boolean; openSettings: () => void }) {
  const { snapshot, bridge, busy, switching, switchingText, switchError, chooseConnectionModel, modelName } = controller;
  const settings = snapshot.settings;
  const route = settings.route;
  const config = route === 'portal' ? undefined : settings[route];
  const model = config?.model ?? '';
  const [open, setOpen] = useState(false);
  const wasSwitching = useRef(!!switching);
  useEffect(() => {
    if (wasSwitching.current && !switching && !switchError) setOpen(false);
    wasSwitching.current = !!switching;
  }, [switching, switchError]);
  type Group = { connection: InferenceConnection; models: ModelInfo[]; loading: boolean; error?: string };
  const [groups, setGroups] = useState<Group[]>([]);
  const [query, setQuery] = useState('');
  const connections = (snapshot.inferenceConnections ?? []).filter(item => item.connected).map(item => {
    const builtIn = item.route === 'local' && builtInModelId(item.config.model);
    return builtIn ? { ...item, name: builtInModels[builtIn].name } : item;
  }).sort((a, b) => {
    const priority = (item: InferenceConnection) => item.route === 'local' ? 0 : item.config.provider === 'openrouter' ? 2 : 1;
    return priority(a) - priority(b) || a.name.localeCompare(b.name);
  });
  const connection = JSON.stringify([connections.map(item => [item.id, item.config.endpoint, item.route === 'byok' && item.config.provider, item.route === 'byok' && item.config.protocol]), settings.openrouter.access, settings.openrouter.zeroDataRetention]);
  useEffect(() => {
    let current = true;
    setGroups([]); setQuery('');
    if (!open) return;
    setGroups(connections.map(connection => ({ connection, models: [], loading: true })));
    for (const connection of connections) {
      const settle = (models: ModelInfo[], error?: string) => { if (current) setGroups(groups => groups.map(group => group.connection.id === connection.id ? { ...group, models, loading: false, error } : group)); };
      void bridge.connectionModels(connection.id).then(result => {
        if (!current) return;
        if (!result.ok) { settle([], result.error); return; }
        const listed: ModelInfo[] = result.value.modelDetails ?? result.value.models.map(id => ({ id }));
        settle(listed);
      }, () => settle([], 'Models could not be loaded.'));
    }
    return () => { current = false; };
  }, [open, connection, bridge]);
  const filteredGroups = groups.map(group => ({ ...group, models: group.models.filter(item => `${group.connection.name} ${item.id} ${item.name ?? ''} ${modelDisplayName(item, group.connection.route === 'byok' && group.connection.config.provider === 'openrouter')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) }));
  const visibleGroups = filteredGroups.filter(group => group.models.length || group.loading || group.error);
  const isBuiltIn = (group: Group) => group.connection.route === 'local' && !!builtInModelId(group.connection.config.model);
  const categories = [
    { id: 'tinygpt', name: 'TinyGPT', members: visibleGroups.filter(isBuiltIn) },
    ...visibleGroups.filter(group => !isBuiltIn(group)).map(group => ({ id: group.connection.id, name: group.connection.name, members: [group] })),
  ].filter(category => category.members.length);
  const loading = groups.some(group => group.loading);
  async function choose(connectionId: string, item: ModelInfo) {
    if (busy || disabled) return;
    if (await chooseConnectionModel(connectionId, item.id, modelDisplayName(item))) setOpen(false);
  }
  return <div className="composer-model-heading"><Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><button type="button" className={`composer-model-trigger${switching && !open ? ' is-switching' : ''}`} disabled={disabled || busy && !switching} aria-busy={!!switching} aria-label={`Choose model: ${switching?.name || modelName || 'No model selected'}`}><span>{switching?.name || modelName || 'Choose a model'}</span>{switching && !open ? <><Loader2 className="animate-spin" aria-hidden="true" /><span className="composer-model-trigger-status" role="status">{switchingText}</span></> : <ChevronDown aria-hidden="true" />}</button></PopoverTrigger>
    <PopoverContent className="composer-model-popover" align="center" side="top" sideOffset={28} aria-label="Choose model">
      <div className="composer-model-search"><Search aria-hidden="true" /><input aria-label="Search models" placeholder="Search models" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <ScrollArea className="composer-model-list" viewportClassName="composer-model-viewport"><div role="listbox" aria-label="Available models">
        {categories.map(category => <div className="composer-model-group" role="group" aria-label={category.name} key={category.id}>
          <div className="composer-model-group-heading"><InferenceProviderIcon provider={category.members[0].connection.route === 'local' ? 'local' : category.members[0].connection.config.provider} /><span>{category.name}</span></div>
          {category.members.some(group => group.loading) && <p className="inference-picker-note" role="status"><Loader2 className="animate-spin" />Loading models…</p>}
          {category.members.map(group => <div key={group.connection.id}>
          {group.error && <p className="inference-picker-note" role="status">{category.members.length > 1 ? group.connection.name + ': ' : ''}{group.error}</p>}
          {group.models.slice(0, 100).map(item => { const selected = group.connection.id === snapshot.activeConnectionId && item.id === model, loading = switching?.connectionId === group.connection.id && switching.model === item.id, failed = switchError?.connectionId === group.connection.id && switchError.model === item.id; return <button type="button" role="option" aria-selected={selected} aria-busy={!!loading} data-switching={loading || undefined} className="composer-model-option" key={item.id} disabled={busy || disabled} onClick={() => void choose(group.connection.id, item)}><span>{modelDisplayName(item, group.connection.route === 'byok' && group.connection.config.provider === 'openrouter')}</span>{loading ? <span className="composer-model-switch-status" role="status"><Loader2 className="animate-spin" aria-hidden="true" />{switchingText}</span> : failed ? <span className="composer-model-switch-status is-error" role="alert">Couldn’t switch. Try again.</span> : selected && !switching && <Check aria-hidden="true" />}</button>; })}
          {group.models.length > 100 && <p className="inference-picker-note">Search to narrow the model list.</p>}
          </div>)}
        </div>)}
        {!groups.length && <p className="inference-picker-note">Connect a provider to choose a model.</p>}
        {!!groups.length && !loading && !filteredGroups.some(group => group.models.length || group.error) && <p className="inference-picker-note">No models found.</p>}
      </div></ScrollArea>
      <Button type="button" variant="ghost" className="inference-configure" onClick={() => { setOpen(false); openSettings(); }}><Settings2 />Configuration</Button>
    </PopoverContent>
  </Popover></div>;
}

export function ComposerEffortPicker({ controller, mode, disabled, openSettings, iconOnly = false }: { controller: Controller; mode: 'chat' | 'code'; disabled: boolean; openSettings: () => void; iconOnly?: boolean }) {
  const { snapshot, busy, switching, switchingText, save, modelName } = controller;
  const effort = snapshot.settings.effort[mode];
  const route = snapshot.settings.route;
  const openrouter = route === 'byok' && snapshot.settings.byok.provider === 'openrouter';
  const nitro = snapshot.settings.openrouter.nitro;
  const bundled = route === 'local' && !!builtInModelId(snapshot.settings.local.model);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(effortLevels.indexOf(effort) * 25);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [narrow, setNarrow] = useState(false);
  const compact = iconOnly || narrow;
  useLayoutEffect(() => {
    const composer = triggerRef.current?.closest('.composer');
    if (!composer || iconOnly) return;
    // Follow the available composer space, including when the workspace opens.
    const measure = () => setNarrow(composer.getBoundingClientRect().width < 560);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(composer);
    return () => observer.disconnect();
  }, [iconOnly]);
  const slider = useRef<HTMLInputElement>(null);
  const draft = useRef(position);
  const dragging = useRef(false);
  const [isDragging, setDragging] = useState(false);
  useEffect(() => { draft.current = effortLevels.indexOf(effort) * 25; setPosition(draft.current); dragging.current = false; setDragging(false); }, [effort, open]);
  const preview = effortLevels[Math.round(position / 25)];
  const label = effortLabel(preview);
  function change(value: number) { draft.current = Math.min(100, Math.max(0, value)); setPosition(draft.current); }
  function commit() {
    dragging.current = false; setDragging(false);
    const value = effortLevels[Math.round(draft.current / 25)]; change(effortLevels.indexOf(value) * 25);
    if (value !== effort && !busy && !disabled) void save(current => ({ ...current, effort: { ...current.effort, [mode]: value } })).then(saved => { if (!saved) change(effortLevels.indexOf(effort) * 25); });
  }
  useEffect(() => {
    if (!isDragging) return;
    const finish = () => { if (dragging.current) commit(); };
    window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish);
    return () => { window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); };
  });
  const trigger = <button ref={triggerRef} type="button" className={`effort-trigger ${compact ? 'effort-icon-trigger' : ''}`} data-effort={effort} disabled={disabled || busy && !switching} aria-busy={!!switching} aria-label={compact ? 'Model and effort' : `Level of effort: ${effortLabel(effort)}`} title={switching ? `${switching.name}: ${switchingText}` : compact ? undefined : open ? 'Select an effort level' : `${bundled?'Level of effort':modelName || 'Choose a model'} ${effortLabel(effort)}`}>
    {switching && !open ? <><Loader2 className="animate-spin" aria-hidden="true" />{!compact && <span role="status">{switchingText}</span>}</> : compact ? <Gauge aria-hidden="true" /> : open ? <span>Select an effort level</span> : <>{openrouter && nitro && <Zap className="effort-nitro-indicator" aria-label="Nitro on" />}{!bundled && <span className="effort-model-name">{modelName || 'Choose a model'}</span>}<span className="effort-level">{effortLabel(effort)}</span></>}
  </button>;
  return <Popover open={open && !disabled} onOpenChange={setOpen}><Tooltip open={compact && !open && !disabled ? undefined : false}><TooltipTrigger asChild><PopoverTrigger asChild>{trigger}</PopoverTrigger></TooltipTrigger><TooltipContent>{switching ? `${switching.name}: ${switchingText}` : 'Model and effort'}</TooltipContent></Tooltip>
    <PopoverContent className={`effort-popover ${isDragging ? 'is-dragging' : ''}`} side="top" align="end" aria-label="Level of effort" data-effort={preview} onOpenAutoFocus={event => { event.preventDefault(); slider.current?.focus({ preventScroll: true }); }}>
      {openrouter && <ControlTooltip label="Nitro"><button type="button" className="effort-nitro" aria-label="Nitro mode" aria-pressed={nitro} disabled={disabled || busy} onClick={() => void save(current => ({ ...current, openrouter: { ...current.openrouter, nitro: !current.openrouter.nitro } }))}><Zap /></button></ControlTooltip>}
      <div className="effort-picker-heading">
        <div className="effort-popover-value" aria-live="polite">{label}</div>
        <ComposerModelPicker controller={controller} disabled={disabled} openSettings={() => { setOpen(false); openSettings(); }} />
      </div>
      <div className="effort-slider-wrap" style={{ '--effort-progress': `calc(var(--effort-thumb-size) / 2 + (100% - var(--effort-thumb-size)) * ${position / 100})`, '--effort-color': preview === 'max' ? '#a875f5' : 'var(--user-accent)' } as CSSProperties}>
        <div className="effort-slider-track" aria-hidden="true"><span className="effort-slider-fill">{preview === 'max' && <span className="effort-max-stars">{Array.from({ length: 14 }, (_, star) => <span key={star} className="effort-max-star" />)}</span>}</span></div>
        <input ref={slider} type="range" min="0" max="100" step="1" value={position} disabled={busy || disabled} className="effort-range" aria-label="Level of effort" aria-valuetext={label}
        onPointerDown={() => { dragging.current = true; setDragging(true); }} onPointerUp={commit} onChange={event => { change(Number(event.target.value)); if (!dragging.current) commit(); }}
        onKeyDown={event => { const next = event.key === 'Home' ? 0 : event.key === 'End' ? 100 : ['ArrowRight', 'ArrowUp'].includes(event.key) ? draft.current + 25 : ['ArrowLeft', 'ArrowDown'].includes(event.key) ? draft.current - 25 : undefined; if (next !== undefined) { event.preventDefault(); change(next); commit(); } }} /></div>
    </PopoverContent>
  </Popover>;
}
