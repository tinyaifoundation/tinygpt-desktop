import { useEffect, useState, useRef, type PointerEvent } from 'react';

/** Overlay controls for CodeMirror's own scrolling viewport. Wrapping it in a
 * second scroll viewport breaks editor virtualization and scroll-to-cursor. */
export function EditorScrollbars({ viewport }: { viewport:HTMLElement|null }) {
  const [size,setSize]=useState({width:0,height:0,scrollWidth:0,scrollHeight:0,left:0,top:0});
  const drag=useRef<{start:number;offset:number;axis:'x'|'y'}|null>(null);
  useEffect(()=>{
    if(!viewport)return;let frame=0;
    const measure=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>setSize({width:viewport.clientWidth,height:viewport.clientHeight,scrollWidth:viewport.scrollWidth,scrollHeight:viewport.scrollHeight,left:viewport.scrollLeft,top:viewport.scrollTop}));};
    const resize=new ResizeObserver(measure);resize.observe(viewport);if(viewport.firstElementChild)resize.observe(viewport.firstElementChild);const mutations=new MutationObserver(measure);mutations.observe(viewport,{childList:true,subtree:true});viewport.addEventListener('scroll',measure,{passive:true});measure();
    return()=>{cancelAnimationFrame(frame);resize.disconnect();mutations.disconnect();viewport.removeEventListener('scroll',measure);};
  },[viewport]);
  function bar(axis:'x'|'y'){
    const horizontal=axis==='x';const visible=horizontal?size.width:size.height;const total=horizontal?size.scrollWidth:size.scrollHeight;const offset=horizontal?size.left:size.top;const track=Math.max(0,visible-10);const length=Math.min(track,Math.max(24,track*visible/total));const travel=track-length;const max=total-visible;if(max<1||travel<1)return null;
    const scroll=(value:number)=>{if(viewport)viewport.scrollTo(horizontal?{left:Math.max(0,Math.min(max,value))}:{top:Math.max(0,Math.min(max,value))});};
    function down(event:PointerEvent<HTMLDivElement>){if(event.target!==event.currentTarget)return;const rect=event.currentTarget.getBoundingClientRect();scroll(((horizontal?event.clientX-rect.left:event.clientY-rect.top)-length/2)/travel*max);}
    return <div className={`editor-scroll-track ${horizontal?'horizontal':'vertical'}`} onPointerDown={down}><div className="editor-scroll-thumb" role="scrollbar" aria-label={horizontal?'Scroll editor horizontally':'Scroll editor vertically'} aria-orientation={horizontal?'horizontal':'vertical'} aria-valuemin={0} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(offset)} tabIndex={0} style={horizontal?{width:length,left:offset/max*travel}:{height:length,top:offset/max*travel}}
      onPointerDown={event=>{event.stopPropagation();drag.current={axis,start:horizontal?event.clientX:event.clientY,offset};event.currentTarget.setPointerCapture(event.pointerId);}}
      onPointerMove={event=>{const active=drag.current;if(active?.axis===axis)scroll(active.offset+((horizontal?event.clientX:event.clientY)-active.start)/travel*max);}}
      onPointerUp={()=>{drag.current=null;}} onLostPointerCapture={()=>{drag.current=null;}}
      onKeyDown={event=>{if(['ArrowDown','ArrowRight','ArrowUp','ArrowLeft','PageDown','PageUp','Home','End'].includes(event.key)){event.preventDefault();scroll(event.key==='Home'?0:event.key==='End'?max:offset+(event.key.startsWith('Page')?visible:40)*(event.key.endsWith('Down')||event.key.endsWith('Right')?1:-1));}}}/></div>;
  }
  return <>{bar('y')}{bar('x')}</>;
}
