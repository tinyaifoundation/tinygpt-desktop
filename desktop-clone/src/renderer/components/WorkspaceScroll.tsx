import { useState, type ReactNode } from 'react';
import { EditorScrollbars } from './EditorScrollbars';

export function WorkspaceScroll({children,className='',viewportClassName=''}:{children:ReactNode;className?:string;viewportClassName?:string}){
  const [viewport,setViewport]=useState<HTMLDivElement|null>(null);
  return <div className={`workspace-scroll-surface ${className}`}><div ref={setViewport} className={`workspace-scroll-viewport ${viewportClassName}`}>{children}</div><EditorScrollbars viewport={viewport}/></div>;
}
