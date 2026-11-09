import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { LockKeyhole, Search, SquareChevronRight, Trash2, X } from '../icons';
import type { DesktopBridge } from '../../shared/contracts';
import type { WorkspaceTerminal } from '../../shared/terminal';
import { ControlTooltip } from './ui/tooltip';

export function TerminalView({ terminal, conversationId, bridge, error }: { terminal:WorkspaceTerminal; conversationId:string; bridge:DesktopBridge; error:(text:string)=>void }) {
  const container=useRef<HTMLDivElement>(null);const instance=useRef<Terminal|null>(null);const search=useRef<SearchAddon|null>(null);const written=useRef(0);const props=useRef({terminal,error});props.current={terminal,error};
  const [query,setQuery]=useState<string|null>(null);const [found,setFound]=useState(true);
  const interactive=terminal.owner==='user'&&terminal.status==='running'&&!terminal.locked;
  async function command(action:'clear'|'use'){const result=await bridge.workspaceTerminal({action,conversationId,id:terminal.id});if(!result.ok)error(result.error);}
  useEffect(()=>{
    if(!container.current)return;
    const term=new Terminal({fontSize:12,fontFamily:'Cascadia Code, Menlo, Consolas, monospace',lineHeight:1.25,scrollback:5000,screenReaderMode:true,disableStdin:!interactive,cursorBlink:interactive,convertEol:false});
    const fit=new FitAddon();const finder=new SearchAddon();term.loadAddon(fit);term.loadAddon(finder);term.open(container.current);instance.current=term;search.current=finder;written.current=0;
    function theme(){const color=(variable:string)=>{const el=document.createElement('span');el.style.color=`var(${variable})`;container.current!.append(el);const value=getComputedStyle(el).color;el.remove();return value;};term.options.theme={background:color('--background'),foreground:color('--foreground'),cursor:color('--foreground'),selectionBackground:color('--accent'),scrollbarSliderBackground:color('--border'),scrollbarSliderHoverBackground:color('--muted-foreground')};}
    function resize(){if(!container.current?.clientHeight||!container.current.clientWidth)return;try{fit.fit();}catch{return;}const t=props.current.terminal;if(t.owner==='user'&&t.status==='running'&&!t.locked)void bridge.workspaceTerminal({action:'resize',conversationId,id:t.id,cols:Math.max(10,Math.min(500,term.cols)),rows:Math.max(2,Math.min(300,term.rows))});}
    const input=term.onData(data=>{const t=props.current.terminal;if(t.owner==='user'&&t.status==='running'&&!t.locked)void bridge.workspaceTerminal({action:'write',conversationId,id:t.id,data}).then(result=>{if(!result.ok)props.current.error(result.error);});});
    term.attachCustomKeyEventHandler(event=>{if(event.type==='keydown'&&(event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'){event.preventDefault();setQuery('');return false;}return true;});
    const observer=new ResizeObserver(resize);observer.observe(container.current);const themeObserver=new MutationObserver(theme);themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['class','style']});theme();resize();
    return()=>{input.dispose();observer.disconnect();themeObserver.disconnect();term.dispose();instance.current=null;search.current=null;};
  },[terminal.id,conversationId,bridge]);
  useEffect(()=>{const term=instance.current;if(!term)return;term.options.disableStdin=!interactive;term.options.cursorBlink=interactive;
    const end=terminal.offset+terminal.output.length;if(written.current<terminal.offset||written.current>end){term.reset();written.current=terminal.offset;}
    if(end>written.current){term.write(terminal.output.slice(written.current-terminal.offset));written.current=end;}
  },[terminal.output,terminal.offset,interactive]);
  function find(next=false){setFound(!query||!!(next?search.current?.findNext(query):search.current?.findPrevious(query)));}
  return <div className="workspace-terminal"><div className="workspace-terminal-toolbar"><span>{terminal.locked?<LockKeyhole/>:<SquareChevronRight/>}<strong>{terminal.owner==='agent'?'Agent terminal':'Terminal'}</strong><span>{terminal.locked?(terminal.busy?'Agent is running a command':'Reserved for this reply'):terminal.owner==='agent'?'Agent finished · read-only transcript':terminal.status==='starting'?'Starting shell…':terminal.status==='running'?'Interactive shell':'Shell closed'}</span></span><ControlTooltip label="Find in terminal"><button className="workspace-icon" aria-label="Find in terminal" onClick={()=>setQuery('')}><Search/></button></ControlTooltip><ControlTooltip label="Clear terminal"><button className="workspace-icon" aria-label="Clear terminal" disabled={terminal.locked} onClick={()=>void command('clear')}><Trash2/></button></ControlTooltip>{!terminal.locked&&!interactive&&terminal.status!=='starting'&&<button className="workspace-view-toggle" onClick={()=>void command('use')}>Start a shell</button>}</div>
    {query!==null&&<form className="workspace-find" onSubmit={event=>{event.preventDefault();find(true);}}><input aria-label="Find in terminal" autoFocus value={query} onChange={event=>{const value=event.target.value;setQuery(value);setFound(!value||!!search.current?.findNext(value,{incremental:true}));}}/><span>{found?'':'No matches'}</span><button type="submit">Next</button><button type="button" onClick={()=>find()}>Previous</button><button type="button" aria-label="Close terminal search" onClick={()=>{setQuery(null);search.current?.clearDecorations();}}><X/></button></form>}
    <div ref={container} className="workspace-terminal-screen" aria-label={terminal.locked?'Agent terminal, input locked':'Terminal output'}/><footer className="workspace-editor-status"><span title={terminal.cwd}>{terminal.cwd}</span>{terminal.locked&&<span><LockKeyhole/>Input locked</span>}</footer></div>;
}
