import { useEffect,useRef,useState,type RefObject } from 'react';
import { REMOTE_FILE_BYTES,type RemoteUpload } from '../../shared/remote-media';
import type { RemoteClient } from './remote-client';

type Upload = {id:string;conversationId:string;file:File;preview?:string;progress:number;source?:RemoteUpload;error?:string;cancelled?:boolean};
async function prepare(file:File):Promise<File>{
  if((file.type.startsWith('image/')||/\.(heic|heif)$/i.test(file.name))&&(!/\.(png|jpe?g|webp)$/i.test(file.name)||file.size>REMOTE_FILE_BYTES)){
    const bitmap=await createImageBitmap(file);
    try{const scale=Math.min(1,2048/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext('2d')!.drawImage(bitmap,0,0,canvas.width,canvas.height);const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('This photo could not be opened.')),'image/jpeg',.88));return new File([blob],file.name.replace(/\.[^.]+$/,'')+'.jpg',{type:'image/jpeg'});}finally{bitmap.close();}
  }
  return file;
}
export function useMobileAttachments(client:RefObject<RemoteClient|null>,conversationId:string|null,ensureConversation:()=>Promise<string>){
  const all=useRef<Upload[]>([]),alive=useRef(true),[version,setVersion]=useState(0),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const refresh=()=>{if(alive.current)setVersion(value=>value+1);};
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;for(const item of all.current){item.cancelled=true;if(item.preview)URL.revokeObjectURL(item.preview);}};},[]);
  const request=(item:Upload,op:'upload-cancel'|'upload-finish')=>client.current!.media({id:crypto.randomUUID(),conversationId:item.conversationId,jobId:item.id,op});
  async function upload(item:Upload){
    item.error=undefined;item.progress=0;refresh();
    try{
      if(item.cancelled)return;
      const start=await client.current!.media({id:crypto.randomUUID(),jobId:item.id,conversationId:item.conversationId,op:'upload-start',name:item.file.name.slice(0,180),bytes:item.file.size});
      if(start?.sourceId){item.source=start;item.progress=100;return;}
      const bytes=new Uint8Array(await item.file.arrayBuffer()),size=49152;
      for(let offset=0;offset<bytes.length;offset+=size*4){
        if(item.cancelled)return;
        await Promise.all(Array.from({length:Math.min(4,Math.ceil((bytes.length-offset)/size))},(_,index)=>{const begin=offset+index*size,chunk=bytes.subarray(begin,Math.min(begin+size,bytes.length));let raw='';for(const byte of chunk)raw+=String.fromCharCode(byte);return client.current!.media({id:crypto.randomUUID(),jobId:item.id,conversationId:item.conversationId,op:'upload-chunk',sequence:begin/size,data:btoa(raw)});}));
        item.progress=Math.min(99,Math.round(Math.min(offset+size*4,bytes.length)/bytes.length*100));refresh();
      }
      if(item.cancelled)return;
      item.source=await request(item,'upload-finish');item.progress=100;
      if(item.cancelled)await request(item,'upload-cancel');
    }catch(cause){if(!item.cancelled)item.error=cause instanceof Error?cause.message:'Upload interrupted. Try again.';}
    finally{refresh();}
  }
  async function add(files:File[]){
    if(!files.length||busy)return;setBusy(true);setError('');
    try{
      const id=await ensureConversation();
      const room=Math.max(0,8-all.current.filter(item=>item.conversationId===id).length);
      if(files.length>room)setError('Choose up to eight files per message.');
      for(const selected of files.slice(0,room)){
        const file=await prepare(selected);
        if(!file.size||file.size>REMOTE_FILE_BYTES){setError('Files must be 8 MB or smaller.');continue;}
        const item:Upload={id:crypto.randomUUID(),conversationId:id,file,preview:file.type.startsWith('image/')?URL.createObjectURL(file):undefined,progress:0};all.current.push(item);refresh();await upload(item);
      }
    }catch(cause){setError(cause instanceof Error?cause.message:'This file could not be added.');}finally{if(alive.current)setBusy(false);}
  }
  function remove(item:Upload){item.cancelled=true;all.current=all.current.filter(value=>value!==item);if(item.preview)URL.revokeObjectURL(item.preview);refresh();void request(item,'upload-cancel').catch(()=>{});}
  function sent(id:string){setError('');for(const item of all.current.filter(item=>item.conversationId===id)){if(item.preview)URL.revokeObjectURL(item.preview);}all.current=all.current.filter(item=>item.conversationId!==id);refresh();}
  return {items:all.current.filter(item=>item.conversationId===conversationId),busy,error,version,add,remove,sent,retry:async(item:Upload)=>{setBusy(true);await upload(item);if(alive.current)setBusy(false);}};
}
