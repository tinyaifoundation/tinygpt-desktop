import { useState } from 'react';
import type { ImageModel, ImageSelection } from '../../shared/image-generation';
import { sameImageModel } from '../../shared/image-generation';
import type { ApprovalRequest } from '../../shared/tools';
import type { DesktopBridge } from '../../shared/contracts';
import type { LibrarySnapshot } from '../../shared/chat';
import { ApprovalCard } from './ApprovalCard';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { ScrollArea } from './ui/scroll-area';
import { ChevronDown, Check } from '../icons';
export function ImageModelPicker({models,value,change,disabled=false}:{models:ImageModel[];value?:ImageSelection;change:(value:ImageModel)=>void;disabled?:boolean}){
  const selected=models.find(item=>sameImageModel(value,item));
  return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" disabled={disabled} className="image-model-picker" aria-label="Image generation model">{selected?.name??'Choose image model'}<ChevronDown className="size-3.5"/></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><ScrollArea className="image-model-menu">{models.map(item=><DropdownMenuItem key={item.connectionId+item.model} onSelect={()=>change(item)}><span className="image-model-option"><strong>{item.name}</strong><small>{item.provider}{item.editing?' · Editing':''}</small></span>{sameImageModel(value,item)&&<Check className="size-4"/>}</DropdownMenuItem>)}</ScrollArea></DropdownMenuContent></DropdownMenu>;
}
export function ImageModelApproval({approval,bridge,update}:{approval:ApprovalRequest;bridge:DesktopBridge;update:(value:LibrarySnapshot)=>void}){
  const [selected,select]=useState<ImageModel>();const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  async function respond(deny=false){setBusy(true);setError('');try{const result=deny?await bridge.approveTool(approval.id,'deny'):selected?await bridge.chooseImageModel(approval.id,selected):null;if(result&&!result.ok)throw new Error(result.error);if(result?.ok)update(result.value);}catch(cause){setError(cause instanceof Error?cause.message:'Could not choose this model.');}finally{setBusy(false);}}
  return <ApprovalCard data-slot="image-model-approval" heading="Image generation" title="Choose an image model" descriptionId={'image-model-'+approval.id} description={<><p className="permission-grant-action">Use a connected provider for image generation and editing. Provider usage charges apply.</p><ImageModelPicker models={approval.imageModels??[]} value={selected} change={select} disabled={busy}/>{selected?.adapter==='openrouter'&&<p className="text-xs text-muted-foreground">Image requests follow your OpenRouter account privacy settings.</p>}{error&&<p role="alert" className="text-destructive text-sm">{error}</p>}</>} actions={<><Button variant="ghost" size="sm" disabled={busy} onClick={()=>void respond(true)}>Cancel</Button><Button variant="pill" size="action" className="rounded-full" disabled={busy||!selected} onClick={()=>void respond()}>Generate image</Button></>}/>;
}
