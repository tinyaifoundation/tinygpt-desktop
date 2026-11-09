import { basename,extname } from 'node:path';
import type { HistoryStore } from './history';
import { extractFile,textExtensions } from './files';
import { normalizeToolImage } from './image-tools';
import { REMOTE_FILE_BYTES,type RemoteUpload } from '../shared/remote-media';
export async function importRemoteAttachment(history:HistoryStore,assertIdle:(id:string)=>void,conversationId:string,filename:string,bytes:Buffer):Promise<RemoteUpload> {
  assertIdle(conversationId);history.conversation(conversationId);
  if(!bytes.length||bytes.length>REMOTE_FILE_BYTES)throw Error('Files must be 8 MB or smaller.');
  const name=basename(filename.replaceAll('\\','/')).replace(/[\u0000-\u001f]/g,'').slice(0,180)||'Attachment',extension=extname(name).toLowerCase();
  const images=['.png','.jpg','.jpeg','.webp'];
  if(!images.includes(extension)&&!['.pdf','.docx','.xlsx','.pptx','.odt'].includes(extension)&&!textExtensions.has(extension))throw Error('Choose a photo, PDF, Office document, or text/code file.');
  if(history.sources.list(conversationId,false).filter(source=>!source.messageId&&['attachment','image','conversation','folder'].includes(source.kind)).length>=8)throw Error('Choose up to eight distinct attachments.');
  if(history.sources.ingestUpload){const source=history.sources.ingestUpload(conversationId,name,bytes,images.includes(extension)?normalizeToolImage(bytes):undefined);return {sourceId:source.id,title:source.title,mime:source.mime,size:source.size};}
  let input:Parameters<HistoryStore['sources']['add']>[1];
  if(images.includes(extension)){const image=normalizeToolImage(bytes);input={kind:'image',title:name,text:'',mime:image.mime,size:bytes.length,image:image.image,originalImage:bytes};}
  else input={kind:'attachment',title:name,text:await extractFile(name,bytes,AbortSignal.timeout(30000)),mime:extension==='.pdf'?'application/pdf':'text/plain',size:bytes.length};
  assertIdle(conversationId);
  if(history.sources.list(conversationId,false).filter(source=>!source.messageId&&['attachment','image','conversation','folder'].includes(source.kind)).length>=8)throw Error('Choose up to eight distinct attachments.');
  const source=history.sources.add(conversationId,input);return {sourceId:source.id,title:source.title,mime:source.mime,size:source.size};
}
export function removeRemoteAttachment(history:HistoryStore,assertIdle:(id:string)=>void,conversationId:string,sourceId:string) {
  assertIdle(conversationId);const source=history.sources.detail(conversationId,sourceId);
  if(source.conversationId!==conversationId||source.messageId||!['image','attachment'].includes(source.kind))throw Error('This attachment cannot be removed.');
  history.sources.remove(conversationId,sourceId);
}
export function validateRemoteAttachments(history:HistoryStore,conversationId:string,ids:string[]){history.sources.attachable(conversationId,ids);for(const id of ids){const source=history.sources.detail(conversationId,id);if(source.conversationId!==conversationId||!['image','attachment'].includes(source.kind))throw Error('This attachment is unavailable for the current message.');}}
