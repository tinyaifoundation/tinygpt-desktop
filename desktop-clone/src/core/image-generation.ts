import type { ImageModel } from '../shared/image-generation';
import type { InferenceConnection } from '../shared/inference-connections';
import type { Settings } from '../shared/config';
import { openRouterAttributionFetch } from './openrouter-attribution';

export const imageErrors = ['No compatible image models are available. Connect an image provider in Configuration.', 'Choose an image model to continue.', 'This image model is no longer available. Choose another model.', 'This model cannot edit images. Choose an editing model.', 'This model cannot produce transparent images. Choose another model.', 'The provider did not return a supported image.', 'The generated image is too large.', 'The image provider rejected this request. Check the selected model and prompt.', 'The image provider did not accept your credentials.', 'The image provider is rate limited. Try again later.', 'This image is unavailable.', 'Image generation was cancelled.'];
export async function imageJson(response: Response, limit = 32_000_000): Promise<any> {
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? imageErrors[8] : response.status === 429 ? imageErrors[9] : imageErrors[7]);
  if (!response.body) throw new Error(imageErrors[5]);
  const reader=response.body.getReader(); const chunks: Uint8Array[]=[]; let bytes=0;
  try { while(true){const value=await reader.read();if(value.done)break;bytes+=value.value.byteLength;if(bytes>limit){await reader.cancel();throw new Error(imageErrors[6]);}chunks.push(value.value);} } finally {reader.releaseLock();}
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw new Error(imageErrors[5]);}
}
export async function discoverImageModels(connection: InferenceConnection, secret: string | undefined, request: typeof fetch = fetch): Promise<ImageModel[]> {
  const provider=connection.route==='byok'?connection.config.provider:'local';
  if(provider==='anthropic')return [];
  const endpoint=connection.config.endpoint.replace(/\/+$/,''); const headers:Record<string,string>={Accept:'application/json'};
  if(secret)headers.Authorization='Bearer '+secret;
  const path=provider==='openrouter'?'/images/models':provider==='xai'?'/image-generation-models':'/models';
  const payload=await imageJson(await openRouterAttributionFetch(request)(endpoint+path,{headers,redirect:'error',signal:AbortSignal.timeout(10000)}),2_000_000);
  const data=provider==='xai'?payload.models:payload.data;
  if(!Array.isArray(data))throw new Error(imageErrors[5]);
  return data.slice(0,10000).flatMap((item:any):ImageModel[]=>{
    if(typeof item.id!=='string'||item.id.length>200)return [];
    const inputs=item.architecture?.input_modalities??item.input_modalities??[];
    const outputs=item.architecture?.output_modalities??item.output_modalities??[];
    const gpt=provider==='openai'&&/^gpt-image-/.test(item.id);
    const dalle=provider==='openai'&&/^dall-e-[23]$/.test(item.id);
    if(!gpt&&!dalle&&provider!=='xai'&&!outputs.includes('image'))return [];
    const editing=gpt||provider==='xai'&&/^grok-imagine-image/.test(item.id)||provider==='openrouter'&&inputs.includes('image')||item.supports_image_editing===true;
    const parameters=item.supported_parameters??{};
    return [{connectionId:connection.id,model:item.id,name:typeof item.name==='string'?item.name.slice(0,200):item.id.replaceAll('-',' '),provider:connection.name,adapter:provider==='openrouter'?'openrouter':provider==='xai'?'xai':'openai',editing,transparency:gpt||parameters.background?.values?.includes('transparent')===true,mask:gpt||item.supports_image_mask===true}];
  });
}
export async function requestGeneratedImage(model: ImageModel, connection: InferenceConnection, secret: string | undefined, input: {prompt:string; reference?:string; mask?:string; transparent?:boolean}, _settings:Settings, signal:AbortSignal, request:typeof fetch=fetch):Promise<Buffer> {
  if(input.reference&&!model.editing)throw new Error(imageErrors[3]);
  if(input.transparent&&!model.transparency)throw new Error(imageErrors[4]);
  const endpoint=connection.config.endpoint.replace(/\/+$/,''); const headers:Record<string,string>={};if(secret)headers.Authorization='Bearer '+secret;
  let path='/images/generations';let body:BodyInit;
  if(model.adapter==='openai'&&input.reference){
    path='/images/edits';const form=new FormData();form.set('model',model.model);form.set('prompt',input.prompt);
    const blob=(image:string)=>new Blob([Uint8Array.from(Buffer.from(image.split(',')[1],'base64'))],{type:image.slice(5,image.indexOf(';'))});
    form.append('image[]',blob(input.reference),'reference.png');
    if(input.mask&&model.mask)form.append('mask',blob(input.mask),'mask.png');
    if(input.transparent)form.set('background','transparent'); body=form;
  }else{
    headers['Content-Type']='application/json';let payload:Record<string,unknown>={model:model.model,prompt:input.prompt,n:1};
    if(model.adapter==='openrouter'){
      // The Image API uses account privacy controls, not Chat routing fields.
      path='/images';payload={...payload,output_format:'png'};
      if(input.reference)payload.input_references=[{type:'image_url',image_url:{url:input.reference}}];
    }else if(model.adapter==='xai'){
      payload.response_format='b64_json';if(input.reference){path='/images/edits';payload.image={url:input.reference,type:'image_url'};}
    }else if(!/^gpt-image-/.test(model.model))payload.response_format='b64_json';
    if(input.transparent)payload.background='transparent';body=JSON.stringify(payload);
  }
  const payload=await imageJson(await openRouterAttributionFetch(request)(endpoint+path,{method:'POST',headers,body,redirect:'error',signal}));
  const base64=payload.data?.[0]?.b64_json;
  if(typeof base64!=='string'||!base64.length||base64.length>28_000_000||!/^[A-Za-z0-9+/]+=*$/.test(base64))throw new Error(imageErrors[5]);
  return Buffer.from(base64,'base64');
}
