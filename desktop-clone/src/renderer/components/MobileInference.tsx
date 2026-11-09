import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, ChevronDown, ChevronLeft, Gauge, LoaderCircle, RefreshCw, Search } from '../icons';
import { effortLabel, effortLevels, modelDisplayName } from '../../shared/effort';
import { builtInModelId } from '../../shared/managed-local';
import { InferenceProviderIcon } from './InferenceProviderIcon';
import { remoteInferenceStateSchema, remoteModelCatalogSchema, type RemoteInferenceRequest, type RemoteInferenceState, type RemoteModelCatalog } from '../../shared/remote-inference';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from './ui/popover';

type Group = RemoteInferenceState['connections'][number] & { models?: RemoteModelCatalog['models']; error?: string };
export function MobileInference({ value, mode, request, changed, busyChanged, disabled, switchingDisabled }: {
  value?: RemoteInferenceState; mode: 'chat' | 'code'; request: (command: RemoteInferenceRequest) => Promise<unknown>;
  changed: (value: RemoteInferenceState) => void; busyChanged: (value: boolean) => void; disabled: boolean; switchingDisabled: boolean;
}) {
  const [open,setOpen] = useState(false), [models,setModels] = useState(false), [query,setQuery] = useState('');
  const [groups,setGroups] = useState<Group[]>([]), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const [position,setPosition] = useState(50), [selecting,setSelecting] = useState(''), [isDragging,setDragging] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // Anchor both views to the whole composer, so opening the model list keeps
  // the same center even when its width changes or the keyboard appears.
  const anchor = useRef({ getBoundingClientRect: () => trigger.current?.closest('.mobile-composer')?.getBoundingClientRect() ?? trigger.current?.getBoundingClientRect() ?? new DOMRect() });
  const current = useRef({request,changed,busyChanged,value}); current.current = {request,changed,busyChanged,value};
  const alive = useRef(true), generation = useRef(0), saving = useRef(false), draft = useRef(50), dragging = useRef(false);
  const effort = value?.effort[mode] ?? 'medium';
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;current.current.busyChanged(false);};},[]);
  useEffect(()=>{if(!dragging.current){draft.current=effortLevels.indexOf(effort)*25;setPosition(draft.current);}},[effort,open,mode]);
  useEffect(()=>{if(disabled&&!saving.current)setOpen(false);},[disabled]);
  const identity = JSON.stringify(value?.connections ?? []);
  useEffect(()=>{
    const token=++generation.current;
    if(!open||!models||!value)return;
    setQuery('');setGroups(value.connections.map(item=>({...item})));
    for(const connection of value.connections)void load(connection.id,token);
    return()=>{generation.current++;};
  },[open,models,identity]);
  async function load(id:string,token=generation.current){
    setGroups(groups=>groups.map(group=>group.id===id?{...group,error:undefined,models:undefined}:group));
    try{const catalog=remoteModelCatalogSchema.parse(await current.current.request({id:crypto.randomUUID(),op:'models',connectionId:id}));if(alive.current&&token===generation.current)setGroups(groups=>groups.map(group=>group.id===id?{...group,models:catalog.models.map(model=>({...model,name:modelDisplayName(model,group.provider==='openrouter')}))}:group));}
    catch(cause){if(alive.current&&token===generation.current)setGroups(groups=>groups.map(group=>group.id===id?{...group,error:cause instanceof Error?cause.message:'Models could not be loaded.'}:group));}
  }
  async function save(command:RemoteInferenceRequest){
    if(saving.current||disabled)return false;
    saving.current=true;setBusy(true);current.current.busyChanged(true);setError('');
    try{const next=remoteInferenceStateSchema.parse(await current.current.request(command));if(alive.current)current.current.changed(next);return true;}
    catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:'This change could not be saved.');return false;}
    finally{saving.current=false;if(alive.current){setBusy(false);setSelecting('');current.current.busyChanged(false);}}
  }
  function change(next:number){draft.current=Math.min(100,Math.max(0,next));setPosition(draft.current);}
  async function commit(){
    dragging.current=false;setDragging(false);
    const selected=effortLevels[Math.round(draft.current/25)];change(effortLevels.indexOf(selected)*25);
    if(selected!==current.current.value?.effort[mode]){
      const saved=await save({id:crypto.randomUUID(),op:'effort',mode,effort:selected});
      if(!saved&&alive.current)change(effortLevels.indexOf(current.current.value?.effort[mode]??'medium')*25);
    }
  }
  useEffect(()=>{const finish=()=>{if(dragging.current)void commit();};window.addEventListener('pointerup',finish);window.addEventListener('pointercancel',finish);return()=>{window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',finish);};});
  const preview=effortLevels[Math.round(position/25)], term=query.trim().toLocaleLowerCase();
  const isBuiltIn = (group:Group) => !!group.builtIn || (!group.provider || group.provider==='local') && !!group.models?.some(model=>builtInModelId(model.id));
  const builtInKind = (group:Group) => group.builtIn ?? group.models?.map(model=>builtInModelId(model.id)).find(Boolean);
  const filtered = groups.map(group=>({...group,models:group.models?.filter(model=>`${group.name} ${model.id} ${model.name}`.toLocaleLowerCase().includes(term))}));
  const visibleGroups = filtered.filter(group=>group.models?.length || !group.models || group.error);
  const categories = [
    { id:'tinygpt',name:'TinyGPT',provider:'local' as const,members:visibleGroups.filter(isBuiltIn).sort((a,b)=>Number(builtInKind(a)==='pro')-Number(builtInKind(b)==='pro')) },
    ...visibleGroups.filter(group=>!isBuiltIn(group)).map(group=>({id:group.id,name:group.name,provider:group.provider??'byok' as const,members:[group]})),
  ].filter(category=>category.members.length);
  return <Popover open={open} onOpenChange={next=>{if(!saving.current){setOpen(next);if(next){setModels(false);setError('');}}}}>
    <PopoverAnchor virtualRef={anchor} />
    <PopoverTrigger asChild><button ref={trigger} type="button" className="mobile-inference-trigger" aria-label="Model and effort" title={value?value.name+' · '+effortLabel(effort):'Restart TinyGPT on your computer to use model controls'} disabled={disabled||!value} aria-busy={busy}>{busy?<LoaderCircle className="animate-spin" />:<Gauge />}</button></PopoverTrigger>
    <PopoverContent className={['effort-popover mobile-inference-popover',models?'is-model-list':'',isDragging?'is-dragging':''].join(' ')} side="top" align="center" collisionPadding={12} aria-label="Model and effort" data-effort={preview} onOpenAutoFocus={event=>event.preventDefault()} onEscapeKeyDown={event=>{if(busy)event.preventDefault();}} onInteractOutside={event=>{if(busy)event.preventDefault();}}>
      {models ? <>
        <div className="mobile-model-header"><button type="button" aria-label="Back to effort" disabled={busy} onClick={()=>setModels(false)}><ChevronLeft /></button><strong>Choose a model</strong></div>
        <label className="mobile-model-search"><Search /><input aria-label="Search models" placeholder="Search models" value={query} onChange={event=>setQuery(event.target.value)} disabled={busy} /></label>
        <div className="mobile-model-list" role="listbox" aria-label="Available models" aria-busy={busy}>
          {categories.map(category=><div key={category.id} role="group" aria-label={category.name}>
            <h3><InferenceProviderIcon provider={category.provider} /><span>{category.name}</span></h3>
            {category.members.some(group=>!group.models&&!group.error)&&<p role="status"><LoaderCircle className="animate-spin" />Loading models…</p>}
            {category.members.map(group=><div key={group.id}>
              {group.error&&<div className="mobile-model-error"><p>{group.error}</p><button type="button" disabled={busy} onClick={()=>void load(group.id)}><RefreshCw />Try again</button></div>}
              {group.models?.slice(0,100).map(model=><button type="button" role="option" aria-selected={value?.connectionId===group.id&&value.model===model.id} aria-busy={selecting===JSON.stringify([group.id,model.id])} key={model.id} disabled={busy||disabled||switchingDisabled} onClick={()=>{setSelecting(JSON.stringify([group.id,model.id]));void save({id:crypto.randomUUID(),op:'select',connectionId:group.id,model:model.id}).then(ok=>{if(ok&&alive.current)setModels(false);});}}>
                <span>{model.name}</span>{selecting===JSON.stringify([group.id,model.id])?<LoaderCircle className="animate-spin" />:value?.connectionId===group.id&&value.model===model.id&&<Check />}
              </button>)}
              {group.models&&group.models.length>100&&<p>Search to narrow the list.</p>}
            </div>)}
          </div>)}
          {!groups.length&&<p>Connect a provider in desktop Settings.</p>}
          {!!groups.length&&!categories.length&&<p>{term?'No matching models.':'No models available.'}</p>}
        </div>
        {switchingDisabled&&<p className="mobile-inference-note">Stop the running reply to switch models.</p>}
      </> : <>
        <div className="effort-picker-heading"><div className="effort-popover-value" aria-live="polite">{effortLabel(preview)}</div><button type="button" className="composer-model-trigger" aria-label={'Choose model: '+(value?.name||'No model selected')} disabled={busy} onClick={()=>{setModels(true);setError('');}}><span>{value?.name||'Choose a model'}</span><ChevronDown /></button></div>
        <div className="effort-slider-wrap" style={{'--effort-progress':'calc(var(--effort-thumb-size) / 2 + (100% - var(--effort-thumb-size)) * '+position/100+')','--effort-color':preview==='max'?'#a875f5':'var(--user-accent)'} as CSSProperties}>
          <div className="effort-slider-track" aria-hidden="true"><span className="effort-slider-fill">{preview==='max'&&<span className="effort-max-stars">{Array.from({length:14},(_,star)=><span key={star} className="effort-max-star" />)}</span>}</span></div>
          <input type="range" min="0" max="100" step="1" className="effort-range" aria-label="Level of effort" aria-valuetext={effortLabel(preview)} value={position} disabled={busy||disabled}
            onPointerDown={()=>{dragging.current=true;setDragging(true);}} onPointerUp={()=>void commit()} onBlur={()=>{if(dragging.current)void commit();}}
            onChange={event=>{change(Number(event.target.value));if(!dragging.current)void commit();}}
            onKeyDown={event=>{const next=event.key==='Home'?0:event.key==='End'?100:['ArrowRight','ArrowUp'].includes(event.key)?draft.current+25:['ArrowLeft','ArrowDown'].includes(event.key)?draft.current-25:undefined;if(next!==undefined){event.preventDefault();change(next);void commit();}}} />
        </div>
        <div className="mobile-effort-labels"><span>Instant</span><span>Max</span></div>
      </>}
      {busy&&<p className="mobile-inference-note" role="status"><LoaderCircle className="animate-spin" />{selecting?'Switching model…':'Saving effort…'}</p>}
      {error&&<p className="mobile-inference-error" role="alert">{error}</p>}
    </PopoverContent>
  </Popover>;
}
