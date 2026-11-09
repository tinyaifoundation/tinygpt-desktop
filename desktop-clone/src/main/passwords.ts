import { app, BrowserWindow, WebContentsView, dialog, ipcMain, powerMonitor, safeStorage } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { NativePasswordStore, type PasswordStore } from './password-native';
import { PasswordVault, passwordOrigin } from './password-vault';
import { passwordPrivacy, PASSWORD_PRIVATE_MESSAGE } from './password-privacy';
import { preparePasswordForm, fillPasswordForm } from '../core/password-form';

const CHANNEL = 'tinygpt:private-password';
const actionSchema = z.discriminatedUnion('action',[
  z.object({action:z.enum(['state','finish','close'])}).strict(),
  z.object({action:z.enum(['fill','remove']),id:z.uuid()}).strict(),
  z.object({action:z.literal('save'),username:z.string().max(254),password:z.string().min(1).max(1024)}).strict(),
]);
const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><title>Private sign-in · TinyGPT</title><style>
*{box-sizing:border-box}body{margin:0;background:#171717;color:#eee;font:14px system-ui}main{height:240px;padding:16px 20px}header,.row,form{display:flex;align-items:center;gap:10px}header{justify-content:space-between;margin-bottom:12px}h1{font-size:16px;margin:0 0 3px}#origin{color:#aaa;font-size:12px}button,input,select{font:inherit;color:inherit;background:#242424;border:1px solid #404040;border-radius:9px;padding:9px 12px;min-width:0}button{cursor:pointer;white-space:nowrap}button:hover{background:#333}button:disabled{opacity:.45;cursor:default}select{flex:1}form{margin-top:10px}input{flex:1;width:160px}#save,#finish{background:#eee;color:#171717}#message{height:19px;font-size:12px;margin:9px 0 3px;color:#bbb}small{font-size:11px;color:#999}#cancel{border:0;background:none}input:focus,select:focus,button:focus-visible{outline:2px solid #84b9ff;outline-offset:2px}
</style></head><body><main><header><div><h1>Private sign-in</h1><div id="origin"></div><div id="site" style="color:#aaa;font-size:12px">Website loading…</div></div><div class="row"><button id="cancel" type="button">Close</button><button id="finish" type="button">Finish sign-in</button></div></header><div class="row"><select id="accounts" aria-label="Saved accounts"></select><button id="fill" type="button">Fill password</button><button id="remove" type="button">Remove</button></div><form id="new-account" autocomplete="off"><input id="username" aria-label="Username" placeholder="Username" maxlength="254" autocomplete="off"><input id="password" type="password" aria-label="Password to save" placeholder="Password to save" maxlength="1024" autocomplete="new-password"><button id="generate" type="button">Generate</button><button id="save" type="submit">Save</button></form><p id="message" role="status">Loading saved accounts…</p><small>Assistant tools are paused. Submit the website’s form yourself, then finish. Closes automatically after 5 minutes.</small></main></body></html>`;
const uiUrl = 'data:text/html;charset=utf-8,'+encodeURIComponent(html);
interface PrivateSignIn { window: BrowserWindow; page: WebContentsView; profile: string; origin: string; epoch: number; timer: ReturnType<typeof setTimeout>; busy: boolean; read?: Promise<void>; closed: Promise<void>; finish: () => Promise<void> }

/** This view is never registered with BrowserController, preview, history or an
 * agent debugger. Its trusted chrome has a separate, non-bridged preload. */
export class PasswordManager {
  private current?: PrivateSignIn;
  private opening = false;
  private generation = 0;
  private vault: PasswordVault;
  constructor(private quiet: () => Promise<void>, private store: PasswordStore = new NativePasswordStore()) {
    this.vault = new PasswordVault(app.getPath('userData'),store,{available:()=>safeStorage.isEncryptionAvailable()&&process.platform!=='linux',encrypt:text=>safeStorage.encryptString(text),decrypt:bytes=>safeStorage.decryptString(bytes)});
    ipcMain.handle(CHANNEL,async(event,input)=>{
      const current = this.current;
      if (!current || current.window.isDestroyed() || event.sender!==current.window.webContents || event.senderFrame!==current.window.webContents.mainFrame || event.senderFrame.url!==uiUrl) return {ok:false,error:'This request is not allowed.'};
      if (current.busy) return {ok:false,error:'Finish the current password request first.'};
      current.busy = true;
      try { const action = actionSchema.parse(input); return {ok:true,value:await this.action(current,action)}; }
      catch (error) {
        // Errors from websites, native libraries and validators must not echo inputs.
        const message = error instanceof Error ? error.message : '';
        const allowed = ['The page changed. Choose Fill password again.','No supported sign-in form was found. Use the website’s form manually.','Password access was canceled or could not be verified.','The saved password is unavailable. Save it again.','The operating system could not save this password.','The operating system could not remove this password.','The password could not be saved.','This sign-in is too long to save.','Enter a username and a password of supported length.'];
        return {ok:false,error:allowed.includes(message)?message:'The password request could not be completed. No password was shared with the assistant.'};
      } finally { current.busy = false; }
    });
    powerMonitor.on('lock-screen',this.lock); powerMonitor.on('suspend',this.lock);
  }
  private lock = () => { this.generation++; if (this.current && !this.current.window.isDestroyed()) this.current.window.destroy(); };
  async open(owner: BrowserWindow, context: {url:string;partition:string}, finish:()=>Promise<void>): Promise<void> {
    if (this.current) { if(this.current.window.isDestroyed())throw Error(PASSWORD_PRIVATE_MESSAGE);this.current.window.show(); this.current.window.focus(); return; }
    if (this.opening) throw Error('The password window is already opening.');
    const origin = passwordOrigin(context.url);
    if (app.commandLine.hasSwitch('remote-debugging-port') || app.commandLine.hasSwitch('remote-debugging-pipe') || process.execArgv.some(arg=>arg.startsWith('--inspect'))) throw Error('Close debugging tools before using saved passwords.');
    passwordPrivacy.enter(); this.opening = true; const generation = this.generation;
    let window: BrowserWindow | undefined;
    try {
      // No credential input or private page exists until every old tool has stopped.
      await this.quiet();
      if (!await this.store.available()) throw Error('Set up Windows Hello or macOS Keychain before using saved passwords.');
      if (generation!==this.generation) throw Error('The password window was closed.');
      if (owner.isDestroyed()) throw Error('The browser window was closed.');
      window = new BrowserWindow({parent:owner,show:false,width:1060,height:850,minWidth:760,minHeight:600,title:'Private sign-in · TinyGPT',autoHideMenuBar:true,webPreferences:{preload:join(__dirname,'../preload/passwords.js'),sandbox:true,contextIsolation:true,nodeIntegration:false,devTools:false,spellcheck:false,partition:'tinygpt-password-ui-'+randomUUID()}});
      window.setMenu(null); window.setContentProtection(true);
      const page = new WebContentsView({webPreferences:{partition:context.partition,sandbox:true,contextIsolation:true,nodeIntegration:false,devTools:false,spellcheck:false}});
      let destroyed!: ()=>void;const closed=new Promise<void>(resolve=>{destroyed=resolve;});
      const current: PrivateSignIn = {window,page,profile:context.partition,origin,epoch:0,busy:false,timer:setTimeout(this.lock,5*60_000),closed,finish}; this.current = current;
      page.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      window.webContents.on('will-navigate',event=>event.preventDefault());
      page.webContents.on('will-navigate',(event,url)=>{try{if(new URL(url).protocol!=='https:')event.preventDefault();}catch{event.preventDefault();}});
      page.webContents.on('will-redirect',(event,url)=>{try{if(new URL(url).protocol!=='https:')event.preventDefault();}catch{event.preventDefault();}});
      page.webContents.on('did-start-navigation',details=>{if(details.isMainFrame){current.epoch++;try{window!.webContents.send('tinygpt:private-password-site',new URL(details.url).origin);}catch{}}});
      const noDownload = (event: Electron.Event,_item: Electron.DownloadItem,contents: Electron.WebContents) => {if(contents===page.webContents)event.preventDefault();};
      const pageSession=page.webContents.session;pageSession.on('will-download',noDownload);
      // Native pages can display the site's own errors, but never forward their
      // title, URL, console messages or network payloads into app/model state.
      const layout = () => {if(!window!.isDestroyed()&&!page.webContents.isDestroyed()){const [width,height]=window!.getContentSize();page.setBounds({x:0,y:240,width,height:Math.max(1,height-240)});}};
      window.contentView.addChildView(page); window.on('resize',layout); layout();
      window.on('closed',()=>{
        clearTimeout(current.timer);pageSession.removeListener('will-download',noDownload);
        const release=()=>{if(this.current===current){this.current=undefined;passwordPrivacy.leave();}destroyed();};
        const pageClosed=new Promise<void>(resolve=>{
          if(page.webContents.isDestroyed())resolve();
          else{page.webContents.once('destroyed',resolve);page.webContents.close({waitForBeforeUnload:false});}
        });
        // Keep desktop tools blocked while an outstanding OS authentication
        // prompt is completing, even if its parent window has already closed.
        void Promise.allSettled([pageClosed,current.read]).then(release);
      });
      await window.loadURL(uiUrl);
      if (this.current!==current || window.isDestroyed()) throw Error('The password window was closed.');
      window.show();
      void page.webContents.loadURL(context.url).catch(()=>{});
    } catch (error) {
      if(window&&!window.isDestroyed())window.destroy();
      if(!this.current&&passwordPrivacy.active)passwordPrivacy.leave();
      throw error;
    } finally { this.opening = false; }
  }
  private valid(current: PrivateSignIn, epoch: number) { let valid=false;try{valid=this.current===current&&!current.window.isDestroyed()&&!current.page.webContents.isDestroyed()&&current.epoch===epoch&&!current.page.webContents.isLoadingMainFrame()&&passwordOrigin(current.page.webContents.getURL())===current.origin;}catch{}if(!valid)throw Error('The page changed. Choose Fill password again.'); }
  private async action(current: PrivateSignIn, action: z.infer<typeof actionSchema>) {
    if(action.action==='state')return {origin:current.origin,accounts:await this.vault.list(current.profile,current.origin)};
    if(action.action==='close'){current.window.destroy();return;}
    if(action.action==='finish'){
      current.window.destroy();
      await current.closed;
      // Fresh navigation only; no replayed submit/click, and no private page state
      // copied back. The normal browser can now observe the shared login session.
      await current.finish();return;
    }
    if(action.action==='save'){
      try {
        const exists=(await this.vault.list(current.profile,current.origin)).some(entry=>entry.username===action.username);
        if(exists){const choice=await dialog.showMessageBox(current.window,{type:'question',message:'Update this saved password?',detail:current.origin,buttons:['Cancel','Update password'],defaultId:0,cancelId:0,noLink:true});if(choice.response!==1)return {saved:false};}
        if(this.current!==current||current.window.isDestroyed())throw Error('The page changed. Choose Fill password again.');
        const saved=await this.vault.save(current.profile,current.origin,{username:action.username,password:action.password});return {saved:true,id:saved.id};
      } finally {action.password='';}
    }
    if(action.action==='remove'){
      const choice=await dialog.showMessageBox(current.window,{type:'question',message:'Remove this saved sign-in?',detail:'This removes the saved password. It does not sign you out of the website.',buttons:['Cancel','Remove'],defaultId:0,cancelId:0,noLink:true});
      if(choice.response===1&&this.current===current){await this.vault.remove(current.profile,current.origin,action.id);return {removed:true};}return {removed:false};
    }
    if(action.action!=='fill')return;
    const epoch=current.epoch, token=randomUUID(); this.valid(current,epoch);
    const prepared=await current.page.webContents.executeJavaScriptInIsolatedWorld(2001,[{code:`(${preparePasswordForm.toString()})(${JSON.stringify(current.origin)},${JSON.stringify(token)})`}]);
    if(prepared!==true)throw Error('No supported sign-in form was found. Use the website’s form manually.');
    const read=this.vault.fill(current.profile,current.origin,action.id,current.window.getNativeWindowHandle(),async secret=>{
      this.valid(current,epoch);
      const filled=await current.page.webContents.executeJavaScriptInIsolatedWorld(2001,[{code:`(${fillPasswordForm.toString()})(${JSON.stringify(token)},${JSON.stringify(secret.username)},${JSON.stringify(secret.password)})`}]);
      if(filled!==true)throw Error('The page changed. Choose Fill password again.');
    });
    current.read=read;
    try{await read;}finally{if(current.read===read)current.read=undefined;}
    return;
  }
  shutdown(){this.lock();powerMonitor.removeListener('lock-screen',this.lock);powerMonitor.removeListener('suspend',this.lock);ipcMain.removeHandler(CHANNEL);}
}
