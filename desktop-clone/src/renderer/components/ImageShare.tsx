import { useState } from 'react';
import type { SourceDetail } from '../../shared/tools';
import type { DesktopBridge } from '../../shared/contracts';
import { Dialog } from './ui/dialog';
import { Button } from './ui/button';
export function ImageShare({source,bridge,open,close}:{source:SourceDetail;bridge:DesktopBridge;open:boolean;close:()=>void}){
  const [status,setStatus]=useState('');const [busy,setBusy]=useState(false);
  async function action(action:'copy'|'download'){setBusy(true);setStatus('');try{const result=await bridge.imageAction({action,conversationId:source.conversationId,sourceId:source.id});if(!result.ok)throw new Error(result.error);if(result.value)setStatus(action==='copy'?'Image copied. Paste it into any app.':'Image saved.');}catch(cause){setStatus(cause instanceof Error?cause.message:'Could not share this image.');}finally{setBusy(false);}}
  return <Dialog open={open} change={value=>{if(!value)close();}} title="Share image" description="Copy the image to share in another app, or save a PNG file."><p className="image-share-title">{source.title}</p>{status&&<p role="status" className="text-sm text-muted-foreground">{status}</p>}<div className="image-dialog-actions"><Button variant="ghost" disabled={busy} onClick={()=>void action('copy')}>Copy image</Button><Button variant="pill" size="action" className="rounded-full" disabled={busy} onClick={()=>void action('download')}>Save image</Button></div></Dialog>;
}
