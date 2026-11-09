import { useId, useRef, useState } from 'react';
import { BlobAvatar } from 'blob-avatar';
import { LayoutGrid, Palette, SmilePlus } from '../icons';
import { botExpressions, botShapes, type BotDesign } from '../lib/bot';
import { ScrollArea } from './ui/scroll-area';
import { ColorPicker } from './ui/color-picker';
import { ControlTooltip } from './ui/tooltip';

const presets = [
  {name:'Lime',color:'#aefa0e',shape:'circle'}, {name:'Violet',color:'#8b5cf6',shape:'pebble'},
  {name:'Blue',color:'#3b93f0',shape:'squircle'}, {name:'Amber',color:'#f5b51b',shape:'triangle'},
  {name:'Pink',color:'#e94fb4',shape:'cloud'}, {name:'Teal',color:'#20c6a3',shape:'droplet'},
  {name:'Silver',color:'#a3a3a3',shape:'ghost'}, {name:'Red',color:'#ff4242',shape:'heart'},
] as const;
const tabs = [{id:'shape',name:'Shape',Icon:LayoutGrid},{id:'expression',name:'Expression',Icon:SmilePlus},{id:'color',name:'Color',Icon:Palette}] as const;
const label = (value: string) => value === 'crosseyed' ? 'Cross-eyed' : value[0].toUpperCase()+value.slice(1);

export function BotAvatarEditor({design,change}: {design:BotDesign;change:(patch:Partial<BotDesign>)=>void}) {
  const [tab,setTab] = useState<typeof tabs[number]['id']>('shape');
  const id = useId(), tabBar = useRef<HTMLDivElement>(null);
  function selectTab(index:number) { const next=tabs[(index+tabs.length)%tabs.length].id;setTab(next);tabBar.current?.querySelector<HTMLButtonElement>(`[data-editor-tab="${next}"]`)?.focus(); }
  return <div className="bot-avatar-editor" aria-label="Avatar editor">
    <div className="bot-editor-presets" aria-label="Vibrant bot colors">{presets.map(preset=><ControlTooltip key={preset.name} label={preset.name}><button type="button" aria-label={`${preset.name} color`} aria-pressed={design.color.toLowerCase()===preset.color} onClick={()=>change({color:preset.color})}><BlobAvatar size={30} shape={preset.shape} color={preset.color} paused animation="idle" aria-hidden="true" /></button></ControlTooltip>)}</div>
    <div className="bot-editor-tabs" ref={tabBar} role="tablist" aria-label="Avatar customization">{tabs.map(({id:key,name,Icon},index)=><ControlTooltip label={name} key={key}><button type="button" role="tab" id={`${id}-${key}`} data-editor-tab={key} aria-label={name} aria-selected={tab===key} aria-controls={`${id}-panel`} tabIndex={tab===key?0:-1} onClick={()=>setTab(key)} onKeyDown={event=>{if(['ArrowRight','ArrowLeft','Home','End'].includes(event.key)){event.preventDefault();selectTab(event.key==='Home'?0:event.key==='End'?tabs.length-1:index+(event.key==='ArrowRight'?1:-1));}}}><Icon aria-hidden="true" /></button></ControlTooltip>)}</div>
    <ScrollArea className="bot-editor-scroll" viewportClassName="bot-editor-viewport"><div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`} className="bot-editor-panel">
      {tab==='shape' && <div className="bot-editor-options" aria-label="Avatar shapes">{botShapes.map(shape=><button type="button" key={shape} className="bot-editor-option" aria-label={`${label(shape)} shape`} aria-pressed={design.shape===shape} onClick={()=>change({shape})}><BlobAvatar size={52} shape={shape} color={design.color} expression={design.expression} animation="idle" paused aria-hidden="true" /><span>{label(shape)}</span></button>)}</div>}
      {tab==='expression' && <div className="bot-editor-options" aria-label="Avatar expressions">{botExpressions.map(expression=><button type="button" key={expression} className="bot-editor-option" aria-label={`${label(expression)} expression`} aria-pressed={design.expression===expression} onClick={()=>change({expression})}><BlobAvatar size={52} shape={design.shape} color={design.color} expression={expression} animation="idle" paused aria-hidden="true" /><span>{label(expression)}</span></button>)}</div>}
      {tab==='color' && <div className="bot-editor-color-panel"><div className="bot-editor-options" aria-label="Bot color palette">{presets.map(preset=><button type="button" key={preset.name} className="bot-editor-option" aria-label={`Choose ${preset.name.toLowerCase()}`} aria-pressed={design.color.toLowerCase()===preset.color} onClick={()=>change({color:preset.color})}><span className="bot-editor-color-chip" style={{backgroundColor:preset.color}} /><span>{preset.name}</span></button>)}</div><ColorPicker value={design.color} onValueChange={color=>change({color})} label="Custom bot color"><button type="button" className="bot-editor-custom-color" aria-label="Custom bot color"><span className="bot-editor-color-chip" style={{backgroundColor:design.color}} /><span>Custom color</span><code>{design.color.toUpperCase()}</code></button></ColorPicker></div>}
    </div></ScrollArea>
  </div>;
}
