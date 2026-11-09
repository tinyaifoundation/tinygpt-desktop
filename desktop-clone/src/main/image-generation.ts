import { randomUUID } from 'node:crypto';
import { nativeImage } from 'electron';
import type { HistoryStore } from './history';
import type { SettingsStore } from './store';
import type { SourceDetail } from '../shared/tools';
import { discoverImageModels, requestGeneratedImage, imageErrors } from '../core/image-generation';
import { sameImageModel, type ImageCatalog, type ImageSelection, type ImageModel } from '../shared/image-generation';

export class ImageGeneration {
  private catalog?: {key:string;at:number;value:ImageCatalog};
  private jobs=new Map<string,AbortController>();
  constructor(private history:HistoryStore, private store:SettingsStore, private changed:(conversationId:string)=>void, private request:typeof fetch=fetch){}
  async models(refresh=false):Promise<ImageCatalog>{
    const connections=this.store.inferenceConnections().filter(item=>item.connected);const key=JSON.stringify(connections.map(item=>[item.id,item.config.endpoint,item.route==='byok'?item.config.provider:'local']));
    if(!refresh&&this.catalog?.key===key&&Date.now()-this.catalog.at<300000)return {...this.catalog.value,selected:this.store.getSettings().imageGeneration};
    const results=await Promise.allSettled(connections.map(item=>discoverImageModels(item,this.store.connectionSecret(item.id),this.request)));
    const value:ImageCatalog={models:results.flatMap(result=>result.status==='fulfilled'?result.value:[]),issues:results.flatMap((result,index)=>result.status==='rejected'?[connections[index].name+': image models could not be loaded.']:[]),selected:this.store.getSettings().imageGeneration};
    this.catalog={key,at:Date.now(),value};return value;
  }
  async select(selection:ImageSelection):Promise<ImageModel>{const model=(await this.models()).models.find(item=>sameImageModel(selection,item));if(!model)throw new Error(imageErrors[2]);await this.store.saveSettings({...this.store.getSettings(),imageGeneration:{connectionId:selection.connectionId,model:selection.model}});return model;}
  async selected(edit=false,transparent=false):Promise<ImageModel|undefined>{const catalog=await this.models();return catalog.models.find(item=>sameImageModel(catalog.selected,item)&&(!edit||item.editing)&&(!transparent||item.transparency));}
  private decode(image:string){const value=nativeImage.createFromDataURL(image);if(value.isEmpty())throw new Error(imageErrors[10]);const size=value.getSize();if(size.width>8192||size.height>8192||size.width*size.height>25_000_000)throw new Error(imageErrors[6]);return value;}
  private save(conversationId:string,title:string,image:string,metadata:unknown){const value=this.decode(image);const png=value.toPNG();if(png.length>20_000_000)throw new Error(imageErrors[6]);const parentId=(metadata as {parentId?:string}).parentId;const parent=parentId?this.source(conversationId,parentId):undefined;const group=parent?.kind==='generated-image'&&parent.url?parent.url:'tinygpt-image-asset:'+randomUUID();const source=this.history.sources.add(conversationId,{kind:'generated-image',title,url:group,text:JSON.stringify(metadata),image:'data:image/png;base64,'+png.toString('base64'),mime:'image/png',size:png.length});this.changed(conversationId);return this.history.sources.detail(conversationId,source.id);}
  source(conversationId:string,sourceId:string){const source=this.history.sources.detail(conversationId,sourceId);if(!source.image)throw new Error(imageErrors[10]);return source;}
  async generate(conversationId:string,model:ImageModel,input:{prompt:string;title:string;reference?:string;mask?:string;transparent?:boolean},signal:AbortSignal,parent?:string){
    signal.throwIfAborted();const connection=this.store.connection(model.connectionId);const secret=this.store.connectionSecret(model.connectionId);
    const bytes=await requestGeneratedImage(model,connection,secret,input,this.store.getSettings(),AbortSignal.any([signal,AbortSignal.timeout(240000)]),this.request);
    signal.throwIfAborted();return this.save(conversationId,input.title,'data:image/png;base64,'+bytes.toString('base64'),{type:'generated-image',prompt:input.prompt,model:model.model,connectionId:model.connectionId,parentId:parent??null});
  }
  async edit(input:{conversationId:string;sourceId:string;jobId:string;model:ImageSelection;prompt:string;reference?:string;mask?:string;transparent?:boolean}){
    const controller=new AbortController();if(this.jobs.has(input.jobId))throw new Error('Image generation was cancelled.');this.jobs.set(input.jobId,controller);
    try { const source=this.source(input.conversationId,input.sourceId);if(input.reference)this.decode(input.reference);if(input.mask)this.decode(input.mask);
      const model=await this.select(input.model);controller.signal.throwIfAborted();
      return await this.generate(input.conversationId,model,{prompt:input.prompt,title:source.title,reference:input.mask&&model.mask?source.image!:input.reference??source.image!,mask:input.mask,transparent:input.transparent},controller.signal,source.id);
    } catch (error) {if(controller.signal.aborted)throw new Error(imageErrors[11]);throw error;} finally {this.jobs.delete(input.jobId);}
  }
  close(){for(const controller of this.jobs.values())controller.abort();}
  cancel(id:string){this.jobs.get(id)?.abort();}
  saveMarkup(conversationId:string,sourceId:string,image:string,label:string):SourceDetail{const source=this.source(conversationId,sourceId);return this.save(conversationId,source.title,image,{type:'generated-image',parentId:source.id,operation:label});}
  resize(conversationId:string,sourceId:string,width:number,height:number){const source=this.source(conversationId,sourceId);const image=this.decode(source.image!).resize({width,height,quality:'best'}).toDataURL();return this.saveMarkup(conversationId,sourceId,image,'Resize');}
}
