const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { build } = require('esbuild');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const main = resolve('artifacts/workspace-tabs-smoke-main.cjs');
  await build({ entryPoints: ['scripts/workspace-design-smoke-main.ts'], outfile: main, bundle: true, platform: 'node', format: 'cjs', external: ['electron', '../out/main/index.js'] });
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `workspace-tabs-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [main], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000); const errors = []; page.on('pageerror', error => errors.push(error.message));
  const size = (width,height=950) => app.evaluate(({BrowserWindow}, {width,height}) => BrowserWindow.getAllWindows()[0].setSize(width,height), {width,height});
  const workspace = page.getByRole('complementary',{name:'Workspace',exact:true});
  try {
    await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
    await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setPosition(-10000,-10000);w.setIgnoreMouseEvents(true);w.setSize(1500,950);w.webContents.setBackgroundThrottling(false);w.showInactive();});
    await page.getByRole('button',{name:'Settings',exact:true}).click(); await page.getByRole('navigation',{name:'Settings sections'}).getByRole('button',{name:'Appearance',exact:true}).click(); await page.getByRole('button',{name:'Dark',exact:true}).click(); await page.getByRole('button',{name:'Back to TinyGPT',exact:true}).click();
    await page.getByRole('button',{name:'Show workspace',exact:true}).click(); await workspace.getByRole('button',{name:'Expand workspace',exact:true}).click();
    await workspace.getByRole('button',{name:'Add workspace tab',exact:true}).click(); await page.getByRole('menuitem',{name:'Files',exact:true}).click();
    for(let i=0;i<2;i++){await workspace.getByRole('treeitem',{name:`document-${i}.md`,exact:true}).evaluate(e=>e.click());await workspace.getByRole('tab',{name:`document-${i}.md`,exact:true}).waitFor();}
    await workspace.locator('.workspace-topbar').screenshot({path:resolve('artifacts/workspace-tabs-few-dark.png')});
    for(let i=2;i<16;i++){await workspace.getByRole('treeitem',{name:`document-${i}.md`,exact:true}).evaluate(e=>e.click());await workspace.getByRole('tab',{name:`document-${i}.md`,exact:true}).waitFor();}
    await workspace.getByRole('button',{name:'More workspace tabs',exact:true}).waitFor();
    assert.equal(await workspace.getByRole('tab',{name:'document-15.md',exact:true}).getAttribute('aria-selected'),'true');
    let geometry=await workspace.locator('.workspace-tabs').evaluate(e=>({fits:e.scrollWidth<=e.clientWidth+1,widths:[...e.querySelectorAll('.workspace-tab')].map(t=>t.getBoundingClientRect().width),names:[...e.querySelectorAll('[role=tab]')].map(t=>t.getAttribute('aria-label'))}));assert.ok(geometry.fits);assert.ok(geometry.widths.every(w=>w>=95&&w<=201));assert.equal(new Set(geometry.names).size,geometry.names.length);
    await workspace.locator('.workspace-topbar').screenshot({path:resolve('artifacts/workspace-tabs-overflow-dark.png')});
    await workspace.getByRole('button',{name:'More workspace tabs',exact:true}).click();
    const menu=page.getByRole('menu');assert.equal(await menu.locator('[data-slot=scroll-area-viewport]').count(),1);const target=await menu.getByRole('menuitem').first().textContent();assert.ok(target);
    await menu.getByRole('menuitem').first().click();await workspace.getByRole('tab',{name:target.trim(),exact:true}).waitFor();assert.equal(await workspace.getByRole('tab',{name:target.trim(),exact:true}).getAttribute('aria-selected'),'true');
    await workspace.getByRole('tab',{name:target.trim(),exact:true}).focus();await page.keyboard.press('End');await workspace.getByRole('tab',{name:'document-15.md',exact:true}).waitFor();assert.equal(await workspace.getByRole('tab',{name:'document-15.md',exact:true}).getAttribute('aria-selected'),'true');
    await workspace.getByRole('button',{name:'Close document-15.md',exact:true}).click();assert.equal(await workspace.getByRole('tab',{name:'document-15.md',exact:true}).count(),0);
    await size(650,750);await workspace.getByRole('button',{name:'More workspace tabs',exact:true}).waitFor();await page.waitForFunction(()=>{const e=document.querySelector('.workspace-tabs');return e.scrollWidth<=e.clientWidth+1;});await workspace.locator('.workspace-topbar').screenshot({path:resolve('artifacts/workspace-tabs-narrow.png')});
    await size(2600);await workspace.getByRole('button',{name:'More workspace tabs',exact:true}).waitFor({state:'hidden'});assert.equal(await workspace.getByRole('tab').count(),17);assert.ok(await workspace.locator('.workspace-tabs').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
    assert.deepEqual(errors,[]);console.log('PASS: rounded tabs, bounded shrinking, More overflow with ShadCN scrolling, selected tab promotion, keyboard navigation, closing, resize back to all tabs, and no horizontal overflow.');
  } finally { await app.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
