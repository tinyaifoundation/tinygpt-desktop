/* Build-time only: no network, accounts, or user data. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const rootOption = process.argv.indexOf('--root');
const root = rootOption < 0 ? path.resolve(__dirname, '..') : path.resolve(process.argv[rootOption + 1]);
const read = p => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const config = JSON.parse(read('knowledge/manifest.json'));
const source = read('src/renderer/lib/settings-search.ts');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exportsObject = {};
new Function('exports', compiled)(exportsObject);
const entries = exportsObject.settingsSearchEntries;
const articles = config.articles.map(article => {
  const text = read(`knowledge/${article.id}.md`).trim();
  if (!text.startsWith(`# ${article.title}\n`) || text.length < 350) throw Error(`Incomplete article: ${article.id}`);
  for (const file of article.sources) read(file);
  return { ...article, text, hash: hash(text) };
});
for (const section of new Set(entries.map(entry => entry.section))) {
  const selected = entries.filter(entry => entry.section === section);
  const text = `# Settings: ${section}\n\nOpen Settings → ${section}. Use Search settings to find a control by its label, then select the result. Some controls open a configuration panel first. Availability depends on your platform and connection.\n\n` + selected.map(entry => `## ${entry.title}\n\n${entry.description}\n\nSearch terms: ${entry.keywords}.`).join('\n\n');
  articles.push({ id: 'settings-' + section.toLowerCase().replace(/[^a-z0-9]+/g, '-'), title: `Settings: ${section}`, sources: ['src/renderer/lib/settings-search.ts'], text, hash: hash(text) });
}
if (new Set(articles.map(a => a.id)).size !== articles.length) throw Error('Duplicate handbook IDs');
// Track the implementation files that authors reviewed. Any change requires a
// deliberate review/rebuild, even when the resulting prose needs no changes.
function implementationFiles(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    if (['assets', 'vendor', 'public'].includes(entry.name)) return [];
    const file = directory + '/' + entry.name;
    return entry.isDirectory() ? implementationFiles(file) : /\.(?:tsx?|css|json)$/.test(file) && !file.endsWith('handbook.generated.json') ? [file] : [];
  });
}
const tracked = [...new Set([...implementationFiles('src'), ...config.articles.flatMap(a => a.sources)])].sort();
const output = JSON.stringify({ schema: 1, version: JSON.parse(read('package.json')).version, sources: Object.fromEntries(tracked.map(p => [p, hash(read(p))])), articles }, null, 2) + '\n';
const target = 'src/shared/handbook.generated.json';
if (process.argv.includes('--check')) {
  if (read(target) !== output) {
    const previous = JSON.parse(read(target));
    const changed = [...new Set([...Object.keys(previous.sources), ...tracked])].filter(file => previous.sources[file] !== JSON.parse(output).sources[file]);
    throw Error(`Handbook is stale. Changed implementation: ${changed.slice(0, 15).join(', ') || 'article/settings/version content'}. Review affected help; run npm run handbook:build, then handbook:check. See knowledge/MAINTENANCE.md.`);
  }
} else fs.writeFileSync(path.join(root, target), output);
console.log(`Handbook ${process.argv.includes('--check') ? 'verified' : 'built'}: ${articles.length} articles, ${entries.length} settings, ${tracked.length} reviewed implementation files.`);
