const {_electron}=require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE||'playwright');
const {resolve,join}=require('node:path');
const {mkdir,writeFile}=require('node:fs/promises');
const assert=require('node:assert/strict');
async function main(){
  const profile=resolve('.tools-smoke-profile',`terminal-${Date.now()}`),folder=join(profile,'Project with spaces');await mkdir(folder,{recursive:true});
  await writeFile(join(folder,'sample.ts'),Array.from({length:150},(_,i)=>`export const value${i} = "${'long line '.repeat(30)}";`).join('\n'));
  const env={...process.env,TINYGPT_TOOLS_PROFILE:profile};delete env.ELECTRON_RUN_AS_NODE;let app;const errors=[];
  try{
    app=await _electron.launch({executablePath:resolve('node_modules/electron/dist/electron.exe'),args:[resolve('scripts/tools-smoke-main.cjs')],env});const page=await app.firstWindow();page.setDefaultTimeout(45000);page.on('pageerror',error=>errors.push(error.message));
    await app.evaluate(({BrowserWindow,dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});for(const w of BrowserWindow.getAllWindows()){w.setIgnoreMouseEvents(true);w.setPosition(-10000,-10000);w.webContents.setBackgroundThrottling(false);w.showInactive();}},folder);
    await page.getByRole('button',{name:'New chat',exact:true}).waitFor();
    const conversationId=await page.evaluate(async()=>{const b=window.tinygpt;const settings=(await b.snapshot()).value.settings;await b.saveSettings({...settings,mode:'code'});const chosen=await b.chooseNewProjectFolder();const project=await b.createProject('Workspace fixture','',false,chosen.value.id);return(await b.createConversation(project.value.id)).value.id;});
    await page.reload();await page.getByRole('button',{name:'Show workspace',exact:true}).click();await page.getByRole('button',{name:'Add workspace tab',exact:true}).click();await page.getByRole('menuitem',{name:'Terminal',exact:true}).click();await page.locator('.xterm').waitFor();
    const terminal=await page.evaluate(async id=>(await window.tinygpt.workspaceTerminal({action:'state',conversationId:id})).value.terminals[0],conversationId);assert.equal(terminal.owner,'user');assert.equal(terminal.locked,false);
    await page.locator('.xterm-helper-textarea').focus();await page.keyboard.type('node -e "console.log(\'PTY_LIVE_OK \'+process.version)"');await page.keyboard.press('Enter');
    await page.waitForFunction(async id=>(await window.tinygpt.workspaceTerminal({action:'state',conversationId:id})).value.terminals[0].output.includes('PTY_LIVE_OK v24.'),conversationId);
    await page.getByRole('button',{name:'Find in terminal',exact:true}).click();await page.getByRole('textbox',{name:'Find in terminal',exact:true}).fill('PTY_LIVE_OK');await page.getByRole('button',{name:'Close terminal search',exact:true}).click();
    await page.getByRole('button',{name:'Add workspace tab',exact:true}).click();await page.getByRole('menuitem',{name:'Files',exact:true}).click();await page.getByRole('treeitem',{name:'sample.ts',exact:true}).click();await page.getByRole('textbox',{name:'Edit sample.ts',exact:true}).waitFor();
    const layout=await page.evaluate(()=>{const tree=document.querySelector('.workspace-file-tree'),editor=document.querySelector('.workspace-file-viewer');return{treeRight:tree.getBoundingClientRect().left>=editor.getBoundingClientRect().right-1,nativeScroll:getComputedStyle(document.querySelector('.cm-scroller')).scrollbarWidth};});assert.deepEqual(layout,{treeRight:true,nativeScroll:'none'});
    await page.getByRole('scrollbar',{name:'Scroll editor vertically',exact:true}).waitFor();await page.getByRole('scrollbar',{name:'Scroll editor horizontally',exact:true}).waitFor();
    await page.getByRole('button',{name:'Find in file',exact:true}).first().click();await page.locator('.cm-search').waitFor();await page.getByRole('button',{name:'close',exact:true}).click();
    await page.getByRole('button',{name:'Toggle word wrap',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Toggle word wrap',exact:true}).getAttribute('aria-pressed'),'true');
    await page.locator('.cm-content').focus();await page.keyboard.press('Control+p');await page.getByRole('dialog',{name:'Quick Open',exact:true}).waitFor();await page.getByRole('combobox',{name:'Find Project file',exact:true}).fill('sample');await page.getByRole('option',{name:'sample.ts sample.ts',exact:true}).waitFor();await page.keyboard.press('Enter');await page.getByRole('dialog',{name:'Quick Open',exact:true}).waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Expand workspace',exact:true}).click();await page.screenshot({path:resolve('artifacts/workspace-editor-lite.png')});
    await page.getByRole('tab',{name:'Terminal',exact:true}).click();await page.screenshot({path:resolve('artifacts/workspace-terminal.png')});
    await page.getByRole('button',{name:'Close Terminal',exact:true}).click();const result=await page.evaluate(async({id,terminalId})=>window.tinygpt.workspaceTerminal({action:'write',conversationId:id,id:terminalId,data:'x'}),{id:conversationId,terminalId:terminal.id});assert.equal(result.ok,false);
    await page.getByRole('button',{name:'Add workspace tab',exact:true}).click();await page.getByRole('menuitem',{name:'Terminal',exact:true}).click();await page.locator('.xterm').waitFor();
    assert.deepEqual(errors,[]);console.log(JSON.stringify({profile,checks:['real native PTY','interactive keyboard input','packaged Node 24 in Project folder with spaces','terminal search','right explorer','custom editor scrollbars on both axes','editor search and word wrap','closed terminal refuses input','Quick Open keyboard search','shutdown with an open shell'],errors}));
  }finally{if(app)await app.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
