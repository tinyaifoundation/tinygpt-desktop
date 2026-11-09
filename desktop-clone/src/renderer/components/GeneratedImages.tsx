import { useEffect, useState } from 'react';
import { Upload } from '../icons';
import type { ToolActivity, SourceDetail } from '../../shared/tools';
import type { DesktopBridge } from '../../shared/contracts';
import { ImageShare } from './ImageShare';
import { ControlTooltip } from './ui/tooltip';
import { MessageNotice } from './elements/error-state';
export function ImageGenerationPlaceholder(){return <div data-slot="image-generation-placeholder" className="image-generation-placeholder" role="status" aria-label="Generating image"><div className="image-generation-dots"/><span className="sr-only">Generating image</span></div>;}
function GeneratedImage({tool,bridge,open}:{tool:ToolActivity;bridge:DesktopBridge;open:(id:string)=>void}){
  const [source,setSource]=useState<SourceDetail|null>(null);const [share,setShare]=useState(false);const [error,setError]=useState('');
  let sourceId='';try{sourceId=JSON.parse(tool.result??'{}').sourceId??'';}catch{}
  useEffect(()=>{let live=true;if(!sourceId)return;void bridge.source(tool.conversationId,sourceId).then(result=>{if(live){if(result.ok)setSource(result.value);else setError(result.error);}});return()=>{live=false;};},[bridge,sourceId,tool.conversationId]);
  if(tool.status==='running')return <ImageGenerationPlaceholder/>;
  if(tool.status==='pending')return null;
  if(tool.status!=='success')return <MessageNotice tone="muted" title={tool.status==='cancelled'?'Image generation cancelled':'Image generation could not finish'}>{tool.result}</MessageNotice>;
  if(error)return <MessageNotice tone="muted" title="Image unavailable">{error}</MessageNotice>;
  return source?.image?<><div className="generated-image" data-slot="generated-image"><button className="generated-image-open" aria-label={'Open '+source.title} onClick={()=>open(source.id)}><img src={source.image} alt={source.title}/></button><button className="generated-image-edit" onClick={()=>open(source.id)}>Edit</button><ControlTooltip label="Share image"><button className="generated-image-share" aria-label="Share image" onClick={()=>setShare(true)}><Upload/></button></ControlTooltip></div><ImageShare source={source} bridge={bridge} open={share} close={()=>setShare(false)}/></>:null;
}
export function GeneratedImages({tools,bridge,open}:{tools:ToolActivity[];bridge:DesktopBridge;open:(id:string)=>void}){return <>{tools.filter(tool=>tool.name==='generate_image').map(tool=><GeneratedImage key={tool.id} tool={tool} bridge={bridge} open={open}/>)}</>;}
