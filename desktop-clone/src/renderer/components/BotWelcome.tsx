import { useRef, useState, type ReactNode, type Ref } from 'react';
import { ArrowRight, Check, ChevronDown, Dices, Pencil, RotateCcw } from '../icons';
import type { BotAvatarAction } from '../lib/bot-avatar';
import { botAnimations as animations } from '../lib/bot-avatar';
import { BotAvatarEditor } from './BotAvatarEditor';
import { RobotAvatar } from './RobotAvatar';
import type { BotDesign } from '../lib/bot';
import { randomBotName } from '../lib/bot-names';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { ScrollArea } from './ui/scroll-area';
import { ControlTooltip } from './ui/tooltip';
import { ColorPicker } from './ui/color-picker';


export function BotWelcome({ design, changeDesign, next, heading, headingLabel, controls, footer, toolbar, sectionRef, sectionLabel = 'Bot personalization' }: {
  design: BotDesign; changeDesign: (design: BotDesign) => void; next?: () => void;
  heading?: ReactNode; headingLabel?: string; controls?: ReactNode; footer?: ReactNode; toolbar?: ReactNode; sectionRef?: Ref<HTMLElement>; sectionLabel?: string;
}) {
  const [preview, setPreview] = useState<{ action: BotAvatarAction; key: number }>({ action: 'idle', key: 0 });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(design.name);
  const cancelled = useRef(false);
  const animation = animations.find(item => item.action === preview.action)!;
  function finishName() { if (!cancelled.current && name.trim()) changeDesign({ ...design, name: name.trim() }); setEditing(false); }
  const change = (patch: Partial<BotDesign>) => { changeDesign({ ...design, ...patch }); if (patch.expression) setPreview(previous => ({ action:'idle',key:previous.key+1 })); };
  return <ScrollArea className="bot-designer-scroll" viewportClassName="bot-designer-viewport">
    <section ref={sectionRef} className="bot-designer" aria-label={sectionLabel}>
      {toolbar}
      <header className="bot-introduction">
        <h1 aria-label={headingLabel ?? `Introducing ${design.name}`}>{heading ?? <><span>Introducing</span>{editing ? <form className="bot-name-editor" onSubmit={event => { event.preventDefault(); finishName(); }}>
          <input aria-label="Bot name" value={name} maxLength={40} autoFocus style={{ width: `${Math.max(7, Math.min(24, name.length + 1))}ch` }} onFocus={event => event.currentTarget.select()} onChange={event => setName(event.target.value)} onBlur={finishName} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; setEditing(false); } }} />
          <Button variant="ghost" size="icon" aria-label="Save bot name" type="submit" onMouseDown={event => event.preventDefault()}><Check /></Button>
        </form> : <span className="bot-name-controls"><ControlTooltip label="Edit name"><button className="bot-name" aria-label="Edit bot name" onClick={() => { cancelled.current = false; setName(design.name); setEditing(true); }}><span>{design.name}</span><Pencil aria-hidden="true" /></button></ControlTooltip><ControlTooltip label="Random bot name"><button type="button" className="bot-name-random" aria-label="Random bot name" onClick={() => change({ name: randomBotName(design.name) })}><Dices aria-hidden="true" /></button></ControlTooltip></span>}</>}</h1>
      </header>
      <div className="bot-design-layout">
        <div className="bot-preview">
          <div className="bot-preview-stage"><RobotAvatar size={208} interactive design={design} action={preview.action} playbackKey={preview.key} className="bot-welcome-avatar" /></div>
          <div className="bot-preview-controls"><DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="sm" aria-label="Preview animation">{animation.label}<ChevronDown /></Button></DropdownMenuTrigger><DropdownMenuContent align="center" aria-label="Bot animation previews"><ScrollArea className="bot-animation-menu"><DropdownMenuRadioGroup value={preview.action} onValueChange={action => setPreview(previous => ({ action: action as BotAvatarAction, key: previous.key + 1 }))}>{animations.map(item => <DropdownMenuRadioItem key={item.action} value={item.action}>{item.label}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></ScrollArea></DropdownMenuContent></DropdownMenu><ControlTooltip label="Replay animation"><Button variant="ghost" size="icon" aria-label="Replay animation" onClick={() => setPreview(previous => ({ ...previous, key: previous.key + 1 }))}><RotateCcw /></Button></ControlTooltip></div>
        </div>
        <div className="bot-design-controls">
          {controls ?? <BotAvatarEditor design={design} change={change} />}
        </div>
      </div>
      {(footer || next) && <footer className="bot-designer-next">{footer ?? <Button variant="pill" size="action" onClick={next}>Next<ArrowRight /></Button>}</footer>}
    </section>
  </ScrollArea>;
}
