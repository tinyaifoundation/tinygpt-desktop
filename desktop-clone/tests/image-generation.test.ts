import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '../src/shared/config';
import { discoverImageModels, imageJson, requestGeneratedImage } from '../src/core/image-generation';
import { SettingsStore } from '../src/main/store';
import { HistoryStore } from '../src/main/history';
import { ImageGeneration } from '../src/main/image-generation';
import { ToolBroker } from '../src/main/tool-broker';
import { ProjectFiles } from '../src/main/files';
import type { BrowserController } from '../src/main/browser';
import type { ImageModel } from '../src/shared/image-generation';
import type { InferenceConnection } from '../src/shared/inference-connections';
const stores:HistoryStore[]=[];afterEach(()=>{stores.splice(0).forEach(store=>store.close());vi.restoreAllMocks();});
const connection=(provider:'openai'|'openrouter'|'xai'|'custom'|'anthropic'):InferenceConnection=>({id:randomUUID(),route:'byok',name:provider,config:{...defaultSettings.byok,provider,endpoint:'https://provider.example/v1'}});
const fakeImage='data:image/png;base64,aGVsbG8=';
const transport=(data:unknown)=>vi.fn(async()=>new Response(JSON.stringify(data))) as unknown as typeof fetch;
const output={data:[{b64_json:'aGVsbG8=',media_type:'image/png'}]};
describe('image provider adapters',()=>{
  it('discovers only generated-image models, keeping vision-input chat models out',async()=>{
    const provider=connection('openrouter');const request=transport({data:[{id:'text/vision',architecture:{input_modalities:['text','image'],output_modalities:['text']}},{id:'photo/edit',name:'Photo Edit',architecture:{input_modalities:['text','image'],output_modalities:['image']},supported_parameters:{background:{type:'enum',values:['transparent']}}},{id:'photo/create',architecture:{input_modalities:['text'],output_modalities:['image']}}]});
    const models=await discoverImageModels(provider,'fixture-secret',request);expect(models.map(item=>item.model)).toEqual(['photo/edit','photo/create']);expect(models[0]).toMatchObject({editing:true,transparency:true,name:'Photo Edit'});expect(models[1].editing).toBe(false);expect(vi.mocked(request).mock.calls[0][0]).toBe('https://provider.example/v1/images/models');
  });
  it('uses distinct OpenAI and xAI catalogs rather than the chat selection',async()=>{
    const models=await discoverImageModels(connection('openai'),'key',transport({data:[{id:'gpt-image-1.5'},{id:'gpt-text'},{id:'dall-e-3'}]}));expect(models).toHaveLength(2);expect(models[0]).toMatchObject({editing:true,mask:true,transparency:true});expect(models[1].editing).toBe(false);
    const request=transport({models:[{id:'grok-imagine-image-2.0'}]});expect((await discoverImageModels(connection('xai'),'key',request))[0].editing).toBe(true);expect(vi.mocked(request).mock.calls[0][0]).toContain('/image-generation-models');expect(await discoverImageModels(connection('anthropic'),'key',request)).toEqual([]);
  });
  it.each(['openai','openrouter','xai'] as const)('creates images using the %s API and edits using its native request format',async adapter=>{
    const provider=connection(adapter);const model:ImageModel={connectionId:provider.id,provider:provider.name,model:adapter==='openai'?'gpt-image-1.5':'photo/edit',name:'Image',adapter,editing:true,transparency:adapter!=='xai',mask:adapter==='openai'};const request=transport(output);const settings={...defaultSettings,openrouter:{...defaultSettings.openrouter,zeroDataRetention:true,allowDataCollection:false}};
    const image=await requestGeneratedImage(model,provider,'key',{prompt:'Make a landscape'},settings,new AbortController().signal,request);expect(image.toString()).toBe('hello');
    await requestGeneratedImage(model,provider,'key',{prompt:'Change the sky',reference:fakeImage,mask:fakeImage},settings,new AbortController().signal,request);
    const calls=vi.mocked(request).mock.calls;const generated=JSON.parse(String(calls[0][1]?.body));expect(generated.model).toBe(model.model);expect(calls[0][1]?.redirect).toBe('error');
    if(adapter==='openai'){expect(calls[1][0]).toContain('/images/edits');const form=calls[1][1]?.body as FormData;expect(form.get('image[]')).toBeInstanceOf(Blob);expect(form.get('mask')).toBeInstanceOf(Blob);expect((calls[1][1]?.headers as any)['Content-Type']).toBeUndefined();expect(generated).not.toHaveProperty('response_format');}
    else {const edited=JSON.parse(String(calls[1][1]?.body));if(adapter==='xai'){expect(edited.image.url).toBe(fakeImage);expect(edited.response_format).toBe('b64_json');}else{expect(edited.input_references[0].image_url.url).toBe(fakeImage);expect(edited).not.toHaveProperty('provider');}}
  });
  it('refuses unsupported edits and transparency before any billed request',async()=>{
    const provider=connection('custom');const model:ImageModel={connectionId:provider.id,provider:'Custom',model:'create',name:'Create',adapter:'openai',editing:false,transparency:false,mask:false};const request=transport(output);
    await expect(requestGeneratedImage(model,provider,'key',{prompt:'Edit',reference:fakeImage},defaultSettings,new AbortController().signal,request)).rejects.toThrow('cannot edit');await expect(requestGeneratedImage(model,provider,'key',{prompt:'Transparent',transparent:true},defaultSettings,new AbortController().signal,request)).rejects.toThrow('transparent');expect(request).not.toHaveBeenCalled();
  });
  it('bounds payloads and keeps provider errors and remote image URLs out of the UI',async()=>{
    await expect(imageJson(new Response('secret echoed by server',{status:401}))).rejects.toThrow('credentials');await expect(imageJson(new Response('123456789'),4)).rejects.toThrow('too large');
    const provider=connection('openai');const model:ImageModel={connectionId:provider.id,provider:'OpenAI',model:'gpt-image-1.5',name:'Image',adapter:'openai',editing:true,transparency:true,mask:true};const request=transport({data:[{url:'http://127.0.0.1/private'}]});await expect(requestGeneratedImage(model,provider,'key',{prompt:'image'},defaultSettings,new AbortController().signal,request)).rejects.toThrow('supported image');expect(request).toHaveBeenCalledOnce();
  });
});
async function fixture(){
  const history=new HistoryStore(':memory:');stores.push(history);const chat=history.createConversation(null);
  const store=new SettingsStore(await mkdtemp(join(tmpdir(),'tinygpt-image-gen-')),{available:()=>true,encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()});await store.load();const settings={...defaultSettings,local:{...defaultSettings.local,model:'text-only'},toolPermissions:{...defaultSettings.toolPermissions,read:'allow' as const}};
  await store.addInferenceConnection(settings,'local');const generation=new ImageGeneration(history,store,()=>{},transport({data:[{id:'fixture-image',name:'Fixture Image',output_modalities:['image'],input_modalities:['text','image'],supports_image_editing:true}]}));
  const generate=vi.spyOn(generation,'generate').mockImplementation(async(id,_model,input)=>{const source=history.sources.add(id,{kind:'generated-image',title:input.title,text:'',image:fakeImage,mime:'image/png'});return history.sources.detail(id,source.id);});
  const broker=new ToolBroker(history,()=>store.getSettings(),{} as BrowserController,new ProjectFiles(history.sources),()=>{});broker.imageGeneration=generation;
  return {history,chat,store,generation,generate,broker,context:{conversationId:chat.id,runId:randomUUID(),signal:new AbortController().signal},request:{id:randomUUID(),name:'generate_image' as const,input:{prompt:'Make a landscape',title:'Landscape'}}};
}
async function waitApproval(broker:ToolBroker){for(let i=0;i<50&&!broker.approvals().length;i++)await new Promise(done=>setTimeout(done,5));expect(broker.approvals()).toHaveLength(1);return broker.approvals()[0];}
describe('image selection and tool lifecycle',()=>{
  it('waits for a model approval, persists the separate selection, and returns stable refs without pixels',async()=>{
    const f=await fixture();const pending=f.broker.execute(f.context,f.request);const approval=await waitApproval(f.broker);expect(approval.imageModels).toHaveLength(1);expect(f.generate).not.toHaveBeenCalled();expect(()=>f.broker.respond(approval.id,'allow-once')).toThrow('Choose an image model');
    const model=approval.imageModels![0];await expect(f.broker.chooseImageModel(approval.id,{...model,model:'unavailable'})).rejects.toThrow('no longer');expect(f.generate).not.toHaveBeenCalled();await f.broker.chooseImageModel(approval.id,model);const result=JSON.parse(await pending);expect(result.imageReference).toContain('tinygpt-image:');expect(JSON.stringify(result)).not.toContain('base64');expect(f.store.getSettings().local.model).toBe('text-only');expect(f.store.getSettings().imageGeneration?.model).toBe('fixture-image');expect(f.history.outputs()[0]).toMatchObject({category:'images',sourceId:result.sourceId});
    await f.broker.execute({...f.context,runId:randomUUID()},{...f.request,id:randomUUID()});expect(f.generate).toHaveBeenCalledTimes(2);expect(f.broker.approvals()).toHaveLength(0);
  });
  it('allows declining the model card and cancels pending selection cleanly',async()=>{
    const f=await fixture();const pending=f.broker.execute(f.context,f.request);const approval=await waitApproval(f.broker);f.broker.respond(approval.id,'deny');expect(JSON.parse(await pending).error).toContain('declined');expect(f.generate).not.toHaveBeenCalled();
    const controller=new AbortController();const stopped=f.broker.execute({...f.context,runId:randomUUID(),signal:controller.signal},{...f.request,id:randomUUID()});await waitApproval(f.broker);controller.abort();await expect(stopped).rejects.toThrow('Cancelled');expect(f.broker.approvals()).toHaveLength(0);expect(f.generate).not.toHaveBeenCalled();
  });
  it('cannot expose another conversation image through an editing request',async()=>{
    const f=await fixture();const other=f.history.createConversation(null);const source=f.history.sources.add(other.id,{kind:'image',title:'Private',text:'',image:fakeImage});const result=JSON.parse(await f.broker.execute(f.context,{...f.request,input:{...f.request.input,reference:'tinygpt-image:'+source.id}}));expect(result.error).toContain('not found');expect(f.generate).not.toHaveBeenCalled();expect(f.broker.approvals()).toHaveLength(0);
  });
  it('honors an ask rule even when an image model is already selected',async()=>{
    const f=await fixture();const model=(await f.generation.models()).models[0];await f.generation.select(model);await f.store.saveSettings({...f.store.getSettings(),toolPermissions:{...f.store.getSettings().toolPermissions,read:'ask'}});
    const run=f.broker.execute(f.context,f.request);const approval=await waitApproval(f.broker);expect(approval.imageModels).toBeUndefined();expect(f.generate).not.toHaveBeenCalled();f.broker.respond(approval.id,'deny');expect(JSON.parse(await run).error).toContain('declined');expect(f.generate).not.toHaveBeenCalled();
  });
  it('blocks generation when image reading permissions are disabled',async()=>{
    const f=await fixture();await f.store.saveSettings({...f.store.getSettings(),toolPermissions:{...f.store.getSettings().toolPermissions,read:'deny'}});expect(JSON.parse(await f.broker.execute(f.context,f.request)).error).toContain('disabled');expect(f.generate).not.toHaveBeenCalled();
  });
});
