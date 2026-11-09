// Live MiniCPM + real TinyGPT harness/broker, fake Gmail only. Sends no real email.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { mkdir, symlink, writeFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  const profile = resolve('.tools-smoke-profile', `minicpm-gmail-${Date.now()}`); await mkdir(profile, { recursive: true });
  await symlink(join(process.env.APPDATA, 'tinygpt-desktop', 'local-models'), join(profile, 'local-models'), 'junction');
  const env = { ...process.env, TINYGPT_CHAT_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/minicpm-gmail-smoke-main.cjs')], env, timeout: 30000 });
    const page = await app.firstWindow(); await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    const installed = await page.evaluate(async () => {
      const unwrap = r => { if (!r.ok) throw Error(r.error); return r.value; };
      unwrap(await window.tinygpt.startManagedLocal(false));
      const plugins = unwrap(await window.tinygpt.installConnector('gmail')); const entry = plugins.entries.find(e => e.manifest.connector === 'gmail');
      unwrap(await window.tinygpt.pluginCredentials(entry.id, { bearer: 'gmail-fixture-token' })); unwrap(await window.tinygpt.connectPlugin(entry.id));
      unwrap(await window.tinygpt.savePlugin({ id: entry.id, manifest: entry.manifest, config: { ...entry.config, rules: { get_mail_profile: 'allow', search_mail: 'allow', read_mail: 'allow' } } }));
      return entry.id;
    });
    const proof = [];
    for (const resume of [false, true]) {
      const sentBefore = await app.evaluate(() => global.gmailFixture.sent.length);
      const id = await page.evaluate(async ({ installed, resume }) => {
        const unwrap = r => { if (!r.ok) throw Error(r.error); return r.value; };
        const c = unwrap(await window.tinygpt.createConversation(null));
        unwrap(await window.tinygpt.selectPlugins(c.id, null, resume ? [] : [installed]));
        unwrap(await window.tinygpt.sendMessage(c.id, 'Send a Gmail email to myself with subject "TinyGPT model report test". Email body: "Fixture report: Model A is first; Model B is second. Source: https://example.test/rankings". This is the complete report; no web research is needed.'));
        return c.id;
      }, { installed, resume });
      let resumed = !resume, approvalSeen = false; const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        const state = await page.evaluate(async id => ({ library: (await window.tinygpt.library()).value, conversation: (await window.tinygpt.conversation(id)).value }), id);
        const approval = state.library.approvals.find(a => a.conversationId === id);
        if (approval) {
          assert.match(approval.details, /send_mail/); assert.equal(await app.evaluate(() => global.gmailFixture.sent.length), sentBefore, 'No mutation before approval');
          const permitted = await page.evaluate(id => window.tinygpt.approveTool(id, 'allow-once'), approval.id); assert.equal(permitted.ok, true); approvalSeen = true;
        }
        if (!state.library.activeRuns.some(r => r.conversationId === id)) {
          if (!resumed) {
            const request = state.conversation.tools.find(t => t.name === 'request_plugin_connection'); assert.ok(request, 'Model must request the missing Gmail connection');
            const result = await page.evaluate(({ id, requestId, pluginId }) => window.tinygpt.resumePluginConnection(id, requestId, pluginId), { id, requestId: request.id, pluginId: installed }); assert.equal(result.ok, true, result.error); resumed = true;
          } else {
            const sent = await app.evaluate(() => global.gmailFixture.sent);
            proof.push({ resume, approvalSeen, tools: state.conversation.tools.map(t => ({ name: t.name, status: t.status })), answer: state.conversation.messages.at(-1).text });
            await writeFile(resolve('artifacts/minicpm-gmail-proof.json'), JSON.stringify(proof, null, 2));
            assert.equal(sent.length, sentBefore + 1, 'Exactly one fake email'); assert.equal(approvalSeen, true); assert.match(sent.at(-1), /To: self@example.test/);
            const body = sent.at(-1).split('\r\n\r\n')[1]; assert.match(Buffer.from(body, 'base64').toString(), /Model A/);
            assert.equal(state.conversation.messages.at(-1).status, 'complete'); break;
          }
        }
        await new Promise(done => setTimeout(done, 200));
      }
      assert.equal(approvalSeen, true, 'Model reached send approval before deadline');
    }
    console.log('MiniCPM Gmail smoke passed: connected and resumed tasks resolve self, call the declared send tool, await broker approval, and send once to the fake endpoint. No real mail sent.');
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

