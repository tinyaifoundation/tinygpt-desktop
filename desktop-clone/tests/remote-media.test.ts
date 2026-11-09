import { randomUUID } from 'node:crypto';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { RemoteMediaBridge } from '../src/main/remote-media';
import { remoteMediaRequestSchema,REMOTE_FILE_BYTES,type RemoteMediaRequest } from '../src/shared/remote-media';
import { remoteTool } from '../src/core/remote-tool';
const bridges:RemoteMediaBridge[]=[];
afterEach(()=>{for(const bridge of bridges.splice(0))bridge.close();});
function setup(){
  const peer={deviceId:randomUUID(),connectionId:randomUUID(),conversationId:randomUUID()},jobId=randomUUID(),source={sourceId:randomUUID(),title:'photo.png',mime:'image/png',size:4};
  const actions={importFile:vi.fn(async()=>source),remove:vi.fn(),preview:vi.fn(()=>({image:'data:image/png;base64,eA==',title:'Screenshot',width:2,height:2})),attachmentPreview:vi.fn(()=>({image:'data:image/jpeg;base64,eA==',title:'Photo',width:2,height:2}))};
  const bridge=new RemoteMediaBridge(actions);bridges.push(bridge);
  const call=(op:string,extra:Record<string,unknown>={},auth=peer)=>bridge.handle(auth,{id:randomUUID(),conversationId:auth.conversationId,jobId,op,...extra} as RemoteMediaRequest);
  return {bridge,actions,peer,source,call};
}
describe('remote file bridge',()=>{
  it('routes thumbnail and larger attachment previews by source ID in the authorized conversation',async()=>{
    const f=setup(),sourceId=randomUUID();
    expect(remoteMediaRequestSchema.safeParse({id:randomUUID(),conversationId:f.peer.conversationId,jobId:randomUUID(),op:'attachment-image',sourceId}).success).toBe(true);
    await f.call('attachment-image',{sourceId});expect(f.actions.attachmentPreview).toHaveBeenLastCalledWith(f.peer.conversationId,sourceId,false);
    await f.call('attachment-image',{sourceId,size:'full'});expect(f.actions.attachmentPreview).toHaveBeenLastCalledWith(f.peer.conversationId,sourceId,true);
    expect(remoteMediaRequestSchema.safeParse({id:randomUUID(),conversationId:f.peer.conversationId,jobId:randomUUID(),op:'attachment-image',sourceId:'C:/private/photo.jpg'}).success).toBe(false);
  });
  it('assembles ordered bytes and makes completion retries idempotent across reconnects',async()=>{
    const f=setup();await f.call('upload-start',{name:'photo.png',bytes:4});await f.call('upload-chunk',{sequence:0,data:Buffer.from('test').toString('base64')});
    expect(await f.call('upload-finish')).toEqual(f.source);expect(f.actions.importFile).toHaveBeenCalledExactlyOnceWith(f.peer.conversationId,'photo.png',Buffer.from('test'));
    const reconnect={...f.peer,connectionId:randomUUID()};expect(await f.call('upload-start',{name:'photo.png',bytes:4},reconnect)).toEqual(f.source);expect(await f.call('upload-finish',{},reconnect)).toEqual(f.source);expect(f.actions.importFile).toHaveBeenCalledTimes(1);
  });
  it('rejects incomplete, out-of-order, and overshooting uploads',async()=>{
    const f=setup();await f.call('upload-start',{name:'x.txt',bytes:4});await expect(f.call('upload-finish')).rejects.toThrow('interrupted');expect(f.actions.importFile).not.toHaveBeenCalled();
    await f.call('upload-start',{name:'x.txt',bytes:4});await expect(f.call('upload-chunk',{sequence:1,data:'eA=='})).rejects.toThrow('interrupted');
    await f.call('upload-start',{name:'x.txt',bytes:1});await expect(f.call('upload-chunk',{sequence:0,data:'dGVzdA=='})).rejects.toThrow('interrupted');
  });
  it('does not let another conversation or socket take over an upload',async()=>{
    const f=setup();await f.call('upload-start',{name:'x.txt',bytes:4});
    for(const auth of [{...f.peer,conversationId:randomUUID()},{...f.peer,connectionId:randomUUID()}]){
      await expect(f.call('upload-start',{name:'x.txt',bytes:4},auth)).rejects.toThrow();await expect(f.call('upload-cancel',{},auth)).rejects.toThrow();await expect(f.call('upload-finish',{},auth)).rejects.toThrow();
    }
    await f.call('upload-chunk',{sequence:0,data:'dGVzdA=='});await f.call('upload-finish');expect(f.actions.importFile).toHaveBeenCalledTimes(1);
  });
  it('drops buffered bytes on disconnect and revocation',async()=>{
    const f=setup();await f.call('upload-start',{name:'x.txt',bytes:4});f.bridge.closePeer(f.peer.connectionId);await expect(f.call('upload-finish')).rejects.toThrow();
    await f.call('upload-start',{name:'x.txt',bytes:4});f.bridge.cancelDevice(f.peer.deviceId);await expect(f.call('upload-finish')).rejects.toThrow();expect(f.actions.importFile).not.toHaveBeenCalled();
  });
  it('removes a source if revocation interrupts its file extraction',async()=>{
    const f=setup();let finish!:(value:typeof f.source)=>void;f.actions.importFile.mockImplementation(()=>new Promise(resolve=>finish=resolve));
    await f.call('upload-start',{name:'x.txt',bytes:4});await f.call('upload-chunk',{sequence:0,data:'dGVzdA=='});const pending=f.call('upload-finish');f.bridge.cancelDevice(f.peer.deviceId);finish(f.source);await expect(pending).rejects.toThrow('cancelled');expect(f.actions.remove).toHaveBeenCalledWith(f.peer.conversationId,f.source.sourceId);
  });
  it('bounds memory and restricts operation inputs',async()=>{
    const f=setup();for(let n=0;n<4;n++)await f.call('upload-start',{jobId:randomUUID(),name:'x.txt',bytes:REMOTE_FILE_BYTES});await expect(f.call('upload-start',{name:'x.txt',bytes:1})).rejects.toThrow('Too many');
    expect(remoteMediaRequestSchema.safeParse({id:randomUUID(),conversationId:f.peer.conversationId,jobId:randomUUID(),op:'upload-start',name:'x.txt',bytes:REMOTE_FILE_BYTES+1}).success).toBe(false);
    expect(remoteMediaRequestSchema.safeParse({id:randomUUID(),conversationId:f.peer.conversationId,jobId:randomUUID(),op:'tool-image',toolId:randomUUID(),path:'C:/secret.png'}).success).toBe(false);
  });
  it('loads a preview using the authorized conversation and tool IDs only',async()=>{
    const f=setup(),toolId=randomUUID();await f.call('tool-image',{toolId});expect(f.actions.preview).toHaveBeenCalledExactlyOnceWith(f.peer.conversationId,toolId);
  });
});
describe('safe mobile tool details',()=>{
  it('includes page targets and a lazy image marker without raw results or private paths',()=>{
    const tool={id:randomUUID(),conversationId:randomUUID(),runId:randomUUID(),name:'browser_screenshot' as const,summary:'Captured page',status:'success' as const,createdAt:1,result:JSON.stringify({url:'https://example.org/page?token=secret',imageReference:'tinygpt-image:'+randomUUID(),private:'RAW_SECRET'})};
    expect(remoteTool(tool)).toMatchObject({target:'https://example.org/page',previewImage:true,result:null});expect(JSON.stringify(remoteTool(tool))).not.toContain('secret');expect(JSON.stringify(remoteTool(tool))).not.toContain('RAW_SECRET');
    expect(remoteTool({...tool,name:'view_image',target:'C:/private/images/photo.png'}).target).toBeUndefined();
    expect(remoteTool({...tool,target:'https://user:password@example.org/',result:null}).target).toBeUndefined();
  });
});
