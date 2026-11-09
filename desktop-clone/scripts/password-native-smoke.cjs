const koffi=require('koffi');
const {resolve}=require('path');
const {randomUUID}=require('crypto');
const assert=require('assert/strict');
if(process.platform!=='win32')throw Error('Run the Windows native password check on Windows.');
const lib=koffi.load(resolve('runtimes/passwords/tinygpt-passwords.dll'));
const available=lib.func('int tg_available()'),put=lib.func('int tg_put(const char *target, const uint8_t *bytes, uint32_t size)'),read=lib.func('int tg_read(const char *target, const uint8_t *window, uint8_t *bytes, uint32_t size)'),remove=lib.func('int tg_remove(const char *target)');
const Credential=koffi.struct({Flags:'uint32_t',Type:'uint32_t',TargetName:'void *',Comment:'void *',LastWrittenLow:'uint32_t',LastWrittenHigh:'uint32_t',CredentialBlobSize:'uint32_t',CredentialBlob:'void *',Persist:'uint32_t',AttributeCount:'uint32_t',Attributes:'void *',TargetAlias:'void *',UserName:'void *'});
const advapi=koffi.load('advapi32.dll'),credRead=advapi.func('bool CredReadW(const char16_t *target, uint32_t type, uint32_t flags, _Out_ void **credential)'),free=advapi.func('void CredFree(void *buffer)');
const target='TinyGPT/BrowserPasswords/SyntheticAcceptance/'+randomUUID(),bytes=Buffer.from(JSON.stringify({username:'synthetic-acceptance',password:'SYNTHETIC_ONLY_'+randomUUID()}));
(async()=>{
  try{
    assert.equal(put('WrongNamespace',bytes,bytes.length),0);
    assert.equal(put(target,bytes,bytes.length),1);
    const pointer=[null];assert.equal(credRead(target,1,0,pointer),true);
    try{const credential=koffi.decode(pointer[0],Credential);const stored=Buffer.from(koffi.decode(credential.CredentialBlob,koffi.array('uint8_t',credential.CredentialBlobSize)));assert.equal(stored.equals(bytes),true);stored.fill(0);}finally{free(pointer[0]);}
    const output=Buffer.alloc(4096);assert.equal(read(target,Buffer.alloc(8),output,output.length),0);assert.equal(output.every(value=>value===0),true);
    const status=await new Promise((done,reject)=>available.async((error,value)=>error?reject(error):done(value)));
    console.log(JSON.stringify({passed:true,nativeStoreRoundTrip:true,invalidOwnerDenied:true,helloAndDesktopInteropAvailable:status===1,realPasswordsRead:0}));
  }finally{bytes.fill(0);assert.equal(remove(target),1);}
})().catch(error=>{console.error(error);process.exitCode=1;});
