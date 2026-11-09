import { imageCropSchema } from '../shared/vision';
import { nativeImage } from 'electron';
import type { HistoryStore } from './history';
import type { ToolImagePreview } from '../shared/remote-media';
import { toolImageReference } from '../core/tool-preview';
import { normalizeToolImage } from './image-tools';
export function attachmentPreview(history:HistoryStore,conversationId:string,sourceId:string,full=false):ToolImagePreview {
  const conversation=history.conversation(conversationId);
  if(!(conversation.allMessages??conversation.messages).some(message=>message.role==='user'&&message.attachmentIds?.includes(sourceId)))throw Error('This image is not attached to a message in this conversation.');
  const source=history.sources.detail(conversationId,sourceId);
  if(!['image','attachment'].includes(source.kind)||!source.mime.startsWith('image/')||!source.image)throw Error('Image preview unavailable.');
  let image=nativeImage.createFromDataURL(source.image);if(image.isEmpty())throw Error('Image preview unavailable.');
  const size=image.getSize(),scale=Math.min(1,(full?1280:256)/Math.max(size.width,size.height));
  image=image.resize({width:Math.max(1,Math.round(size.width*scale)),height:Math.max(1,Math.round(size.height*scale))});
  const limit=full?250000:64000;let bytes=image.toJPEG(full?82:76);
  if(bytes.length>limit)bytes=image.resize({width:Math.max(1,Math.round(image.getSize().width*.7))}).toJPEG(60);
  if(bytes.length>limit)throw Error('Image preview too large.');
  return {image:'data:image/jpeg;base64,'+bytes.toString('base64'),title:source.title.slice(0,180),...size};
}
export function toolPreview(history: HistoryStore,conversationId: string,toolId: string): ToolImagePreview {
  const tool = history.conversation(conversationId).tools.find(tool => tool.id === toolId), reference = tool && toolImageReference(tool);
  if (!tool || !reference) throw Error('This step has no saved image preview.');
  const source = history.sources.detail(conversationId,reference); if (!source.image) throw Error('Saved image unavailable.');
  let image = nativeImage.createFromDataURL(source.image);
  const crop = imageCropSchema.safeParse(JSON.parse(tool.result!).crop).data;
  if (crop) { const original = history.sources.originalImage(conversationId,reference); if (original) image = nativeImage.createFromDataURL(normalizeToolImage(original,crop).image); }
  if (image.isEmpty()) throw Error('Saved image unavailable.');
  const size = image.getSize(), scale = Math.min(1,960 / Math.max(size.width,size.height));
  image = image.resize({width:Math.max(1,Math.round(size.width*scale)),height:Math.max(1,Math.round(size.height*scale))});
  let bytes = image.toJPEG(78);
  if (bytes.length > 200000) bytes = image.resize({width:Math.max(1,Math.round(image.getSize().width*.6))}).toJPEG(60);
  if (bytes.length > 300000) throw Error('Image preview too large.');
  return {image:'data:image/jpeg;base64,'+bytes.toString('base64'),title:source.title.slice(0,180),...size};
}
