import { ipcRenderer } from 'electron';

// Deliberately no contextBridge or general desktop API in this window. The
// website lives in a different sandboxed WebContents without any preload.
window.addEventListener('DOMContentLoaded',()=>{
  const element=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
  const accounts=element<HTMLSelectElement>('accounts'), username=element<HTMLInputElement>('username'), password=element<HTMLInputElement>('password'), message=element<HTMLParagraphElement>('message');
  let busy=false;
  const updateControls=()=>{for(const button of document.querySelectorAll<HTMLButtonElement>('button'))button.disabled=busy;accounts.disabled=busy;username.disabled=busy;password.disabled=busy;element<HTMLButtonElement>('fill').disabled=busy||!accounts.value;element<HTMLButtonElement>('remove').disabled=busy||!accounts.value;};
  const send=async(input:unknown)=>{
    const response=await ipcRenderer.invoke('tinygpt:private-password',input);
    if(!response.ok)throw Error(response.error);return response.value;
  };
  const refresh=async()=>{
    const state=await send({action:'state'}), selected=accounts.value;
    element('origin').textContent='Saved passwords for '+state.origin;
    accounts.replaceChildren();
    for(const account of state.accounts){const option=document.createElement('option');option.value=account.id;option.textContent=account.username||'Account without a username';accounts.append(option);}
    if(!state.accounts.length){const option=document.createElement('option');option.value='';option.textContent='No saved accounts for this site';accounts.append(option);}
    else if([...accounts.options].some(option=>option.value===selected))accounts.value=selected;
  };
  const perform=async(action:()=>Promise<void>)=>{if(busy)return;busy=true;updateControls();message.textContent='';try{await action();}catch(error){message.textContent=error instanceof Error?error.message:'The request could not be completed.';}finally{busy=false;updateControls();}};
  accounts.addEventListener('change',updateControls);
  element('new-account').addEventListener('submit',event=>{event.preventDefault();if(!event.isTrusted)return;void perform(async()=>{
    const value=password.value;password.value='';
    if(!value)throw Error('Enter a password to save.');
    const result=await send({action:'save',username:username.value,password:value});await refresh();if(result.saved){accounts.value=result.id;message.textContent='Saved locally. Choose Fill password to sign in.';}else message.textContent='The saved password was not changed.';
  });});
  element('fill').addEventListener('click',event=>{if(event.isTrusted)void perform(async()=>{await send({action:'fill',id:accounts.value});message.textContent='Filled. Submit the website’s sign-in form, then finish.';});});
  element('remove').addEventListener('click',event=>{if(event.isTrusted)void perform(async()=>{const result=await send({action:'remove',id:accounts.value});await refresh();message.textContent=result.removed?'Saved password removed.':'The saved password was not changed.';});});
  element('finish').addEventListener('click',event=>{if(event.isTrusted){password.value='';void perform(async()=>{await send({action:'finish'});});}});
  element('cancel').addEventListener('click',event=>{if(event.isTrusted){password.value='';void perform(async()=>{await send({action:'close'});});}});
  element('generate').addEventListener('click',event=>{if(!event.isTrusted||busy)return;const bytes=crypto.getRandomValues(new Uint8Array(24));const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';password.value=Array.from(bytes,value=>alphabet[value&63]).join('');bytes.fill(0);message.textContent='Generated a 24-character password. Save it before using it.';});
  ipcRenderer.on('tinygpt:private-password-site',(_event,value)=>{element('site').textContent=typeof value==='string'?'Website: '+value:'Website loading…';});
  void perform(async()=>{await refresh();message.textContent='Passwords stay in the OS store. The assistant cannot inspect this window.';});
});
