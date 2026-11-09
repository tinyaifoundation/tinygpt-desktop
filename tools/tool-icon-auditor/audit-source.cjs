const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const app = path.join(root, 'desktop-clone');
const req = createRequire(path.join(app, 'package.json'));
const ts = req('typescript');
const React = req('react');
const { renderToStaticMarkup } = req('react-dom/server');
const { build } = req('esbuild');
const directory = path.join(root, 'artifacts/tool-icon-audit');
const sources = new Map();
function read(relative) {
  const text = fs.readFileSync(path.join(app, relative), 'utf8');
  sources.set(relative, { path: `desktop-clone/${relative}`, sha256: createHash('sha256').update(text).digest('hex') });
  return text;
}
function parse(relative) { return ts.createSourceFile(relative, read(relative), ts.ScriptTarget.Latest, true, relative.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS); }
function find(source, name) {
  let found;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) found = node.initializer; ts.forEachChild(node, visit); }
  visit(source);
  if (!found) return undefined;
  while (ts.isAsExpression(found) || ts.isParenthesizedExpression(found)) found = found.expression;
  return found;
}
function ref(source, node) { return `desktop-clone/${source.fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`; }
function labelPairs(source, name) {
  const object = find(source, name);
  if (!object || !ts.isObjectLiteralExpression(object)) return {};
  return Object.fromEntries(object.properties.filter(ts.isPropertyAssignment).map(p => [p.name.getText(source).replace(/^['"]|['"]$/g,''), p.initializer.elements.filter(ts.isStringLiteral).map(n => n.text)]));
}
function slugOf(Component) {
  const svg = renderToStaticMarkup(React.createElement(Component, { size: 24, color: '#000', strokeWidth: 1.25, isolated: true }));
  const slug = /\bsolar-([a-z0-9-]+)-linear\b/.exec(svg)?.[1];
  if (!slug) throw new Error('The production icon resolver returned an unsupported non-Solar glyph.');
  return slug;
}
function classify(name) {
  if (name.startsWith('computer_')) return 'Computer';
  if (/^(browser_|search_web$|read_page$)/.test(name)) return 'Web & browser';
  if (name.startsWith('code_')) return 'Coding agent';
  if (name.startsWith('work_')) return 'Work state';
  if (/skill/.test(name)) return 'Skills';
  if (name === 'search_help') return 'Product help';
  if (name === 'calculate') return 'Calculator';
  if (/image|^present$/.test(name)) return 'Images & interfaces';
  if (/^(load_tools|invoke_tool|request_plugin_connection)$/.test(name)) return 'Connections';
  if (/^(model_load|file_prepare)$/.test(name)) return 'System activity';
  return 'Project & sources';
}
async function main() {
  fs.mkdirSync(directory, { recursive: true });
  let previous = { rows: [], newToolIds: [] };
  try { previous = JSON.parse(fs.readFileSync(path.join(directory, 'audit.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const messages = parse('src/renderer/components/ConversationMessages.tsx');
  const mappingSource = parse('src/renderer/tool-icons.tsx');
  const labels = labelPairs(messages, 'toolLabels');
  const overrideSlugs = JSON.parse(read('src/shared/tool-icon-overrides.json'));
  const bundle = path.join(directory, 'production-icon-resolver.cjs');
  const built = await build({
    stdin: { contents: `export { toolIcon } from './src/renderer/tool-icons';
      export { toolNameSchema, nativeCodeToolNameSchema } from './src/shared/tools';
      export { computerToolLabel } from './src/shared/computer';
      export { workToolNames } from './src/shared/work';
      export { friendlyToolLabel } from './src/shared/tool-labels';
      export { browserActivityLabel } from './src/shared/browser-tool-labels';
      export { ConnectorClient } from './src/main/connector-tools';
      export { agentTools } from './src/core/agent-tools';`, resolveDir: app, loader: 'ts' },
    outfile: bundle, platform: 'node', format: 'cjs', bundle: true, write: false, metafile: true,
    external: ['react','react/jsx-runtime'], logLevel: 'silent', absWorkingDir: app,
  });
  // Use the real resolver: family rules and direct imports must match production.
  // Only enumerate declarations. Never invoke tools, requests or account access.
  fs.writeFileSync(bundle, built.outputFiles[0].contents);
  const production = require(bundle);
  for (const input of Object.keys(built.metafile.inputs)) if (input.startsWith('src/') && fs.existsSync(path.join(app,input))) read(input);
  const rows = [], ids = new Set();
  const builtins = new Set(production.toolNameSchema.options);
  const native = new Set(production.nativeCodeToolNameSchema.options);
  const work = new Set(production.workToolNames);
  const available = mode => new Set(production.agentTools({ mode, computer: true, vision: true, imageTools: true, workTask: {} }).map(tool => tool.name));
  const chatTools = available('chat'), workTools = available('code');
  const mappingRef = ref(mappingSource, find(mappingSource, 'toolIcons'));
  function add(id, extra = {}) {
    if (ids.has(id)) return;
    ids.add(id);
    const name = extra.name || id;
    const slug = slugOf(production.toolIcon(name, id.includes('/') ? id : undefined));
    const pair = [true,false].map(active => production.browserActivityLabel({name,summary:''},active) || production.computerToolLabel(name,active) || labels[name]?.[active ? 0 : 1] || production.friendlyToolLabel(name));
    const modes = [chatTools.has(name) ? 'Chat' : '',workTools.has(name) ? 'Work' : ''].filter(Boolean);
    rows.push({ id, name, displayLabel: production.friendlyToolLabel(name), group: classify(name), slug,
      semantic: `toolIcon → ${slug}`, active: pair[0], complete: pair[1], fallback: slug === 'library' && !overrideSlugs[id], visibility: 'Tool row',
      availability: modes.length ? modes.join(' / ') + ' · subject to connection, model and permission gates' : native.has(name) ? 'Coding agent activity / compatibility handler' : work.has(name) ? 'Saved Work compatibility state' : 'Host-generated activity',
      source: mappingRef, labelKind: 'Production fallback label; runtime summary and model status may vary', ...extra });
  }
  const toolsSource = parse('src/shared/tools.ts');
  const execution = find(toolsSource, 'executionToolNameSchema');
  const extraNames = [];
  function enumVisit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(toolsSource) === 'z.enum' && ts.isArrayLiteralExpression(node.arguments[0])) for (const value of node.arguments[0].elements) if (ts.isStringLiteral(value)) extraNames.push(value.text);
    ts.forEachChild(node,enumVisit);
  }
  if (execution) enumVisit(execution);
  for (const name of [...builtins, ...native, ...work, ...extraNames]) add(name);
  for (const [kind,group] of [['gmail','Gmail'],['gdrive','Google Drive'],['gcalendar','Google Calendar'],['github','GitHub'],['slack','Slack']]) {
    const connector = new production.ConnectorClient(kind, () => undefined, () => { throw new Error('The auditor cannot make account requests.'); });
    for (const tool of connector.tools()) add(`${group.toLowerCase().replaceAll(' ','-')}/${tool.name}`, {
      name: tool.name, group, displayLabel: tool.label, active: `${tool.label} · ${group}`, complete: `${tool.label} · ${group}`,
      source: 'desktop-clone/src/main/connector-tools.ts', description: tool.description,
      availability: 'Connector connected, selected and permitted; send scopes may be required', runtimeName: 'ext_<readable name>_<24-character hash>', labelKind: 'Registered label · plugin name; model status may override it',
    });
  }
  const plugins = parse('src/main/plugin-service.ts');
  function registerVisit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(plugins) === 'this.register' && ts.isStringLiteral(node.arguments[1]) && ts.isStringLiteral(node.arguments[2])) {
      const name = node.arguments[1].text, label = node.arguments[2].text;
      add(`plugin/${name}`, { name, group: 'Local plugins', displayLabel: label, active: `${label} · {plugin name}`, complete: `${label} · {plugin name}`, source: ref(plugins,node), availability: 'Selected plugin declares this resource, prompt, report or skill action', labelKind: 'Registered label · plugin name' });
    }
    ts.forEachChild(node,registerVisit);
  }
  registerVisit(plugins);
  // Dedicated context UI does not go through toolIcon; resolve its actual import.
  let optimization;
  function optimizationVisit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'ContextOptimization') optimization = node; ts.forEachChild(node,optimizationVisit); }
  optimizationVisit(messages);
  if (optimization) {
    const iconName = /<([A-Z]\w+Icon)\b/.exec(optimization.getText(messages))?.[1];
    let slug;
    for (const statement of messages.statements) if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) if (statement.importClause.namedBindings.elements.some(item=>item.name.text === iconName)) slug = /\/linear\/(.+)$/.exec(statement.moduleSpecifier.text)?.[1];
    if (!slug) throw new Error('Cannot resolve the conversation optimization icon.');
    add('activity/context_optimization', { name:'context_optimization', group:'System activity', displayLabel:'Optimize the conversation', slug, semantic:iconName, fallback:false, active:'Automatically optimizing conversation', complete:'Optimized the conversation', source:ref(messages,optimization), availability:'Conversation context optimization', visibility:'Context activity row', labelKind:'Fixed host labels' });
  }
  for (const row of rows) if (['present','generate_image'].includes(row.name)) row.visibility = 'Hidden from normal tool rows · separate result UI';
  add('invoke_tool',{ group:'Connections', internal:true, editable:false, fallback:false, visibility:'Internal dispatcher · actual action has its own row', active:'Invoke a discovered tool',complete:'Invoked a discovered tool',source:'desktop-clone/src/core/stable-work-tools.ts' });
  add('ext_*',{ group:'Dynamic tools', visibility:'Dynamic tool family', availability:'MCP tools discovered when a selected server connects; account catalogs are not queried here',active:'{registered tool label} · {plugin name}', complete:'{registered tool label} · {plugin name}' });
  add('bot_*',{ group:'Dynamic tools', visibility:'Saved compatibility tool family', availability:'Historical bot-prefixed tools; current Bot uses host-managed tool catalogs',active:'{saved tool summary}',complete:'{saved tool summary}' });
  const groupOrder = ['Web & browser','Project & sources','Computer','Images & interfaces','Calculator','Product help','Skills','Connections','Work state','Coding agent','Gmail','Google Drive','Google Calendar','GitHub','Slack','Local plugins','System activity','Dynamic tools'];
  rows.sort((a,b)=>groupOrder.indexOf(a.group)-groupOrder.indexOf(b.group));
  const atlas = {};
  const iconDirectory = path.join(app,'node_modules/@solar-icons/react/dist/icons/linear');
  for (const filename of fs.readdirSync(iconDirectory).filter(name=>name.endsWith('.mjs')).sort()) {
    const mod = await import(pathToFileURL(path.join(iconDirectory,filename)).href);
    atlas[filename.slice(0,-4)] = renderToStaticMarkup(React.createElement(Object.values(mod)[0], {size:24,color:'#000',strokeWidth:1.25,isolated:true}));
  }
  for (const row of rows) if (!atlas[row.slug]) throw new Error(`Missing installed icon: ${row.id} → ${row.slug}`);
  const previousIds = new Set(previous.rows.map(row=>row.id));
  const newToolIds = [...new Set([...(previous.newToolIds || []), ...rows.filter(row=>!previousIds.has(row.id)).map(row=>row.id)])].filter(id=>ids.has(id));
  const generatedAt = new Date().toISOString();
  const audit = { version:2, generatedAt, auditedOn:generatedAt.slice(0,10), scope:'Latest desktop-clone production source; capability inventory, not live connections',
    appVersion: JSON.parse(read('package.json')).version, solarVersion:req('@solar-icons/react/package.json').version,
    sourceFingerprint:createHash('sha256').update(JSON.stringify([...sources.values()])).digest('hex'), rows,groupOrder,newToolIds,sources:[...sources.values()],
    stats:{ concrete:rows.filter(row=>!row.id.endsWith('*') && !row.internal && !row.id.startsWith('activity/')).length, internalWrappers:rows.filter(row=>row.internal).length,
      dynamicFamilies:rows.filter(row=>row.id.endsWith('*')).length,systemActivities:rows.filter(row=>row.id.startsWith('activity/')).length,
      fallbackConcrete:rows.filter(row=>row.fallback && !row.id.endsWith('*')).length,currentGlyphs:new Set(rows.filter(row=>row.editable !== false).map(row=>row.slug)).size,availableSlugs:Object.keys(atlas).length,newTools:newToolIds.length } };
  fs.writeFileSync(path.join(directory,'audit.json'),JSON.stringify(audit,null,2));
  fs.writeFileSync(path.join(directory,'solar-linear.json.gz'),gzipSync(JSON.stringify(atlas)));
  console.log(JSON.stringify({ ...audit.stats,generatedAt,output:path.join(directory,'audit.json') }));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
