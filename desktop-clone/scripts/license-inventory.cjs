const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const root = join(__dirname, '..'), target = join(root, 'licenses/dependency-inventory.json');
function expectedInventory() {
  const text = readFileSync(join(root, 'package-lock.json'), 'utf8'), lock = JSON.parse(text);
  const packages = new Map();
  for (const [path, item] of Object.entries(lock.packages)) {
    if (!path || item.dev || !path.includes('node_modules/')) continue;
    const name = item.name || path.replace(/^.*node_modules\//, '');
    const row = { name, version: item.version, license: typeof item.license === 'string' ? item.license : 'MISSING' };
    if (name === 'buffers' && item.version === '0.1.1' && row.license === 'MISSING') {
      row.license = 'MIT/X11';
      row.evidence = 'https://github.com/bitpay/node-buffers/commit/1b745ee35d33eb166e15ef1866073a07c6d7de87';
    }
    const parent = lock.packages['node_modules/opencode-ai'];
    if (/^opencode-(?:darwin|linux|windows)-/.test(name) && row.license === 'MISSING' && parent?.optionalDependencies?.[name] === item.version && parent.license === 'MIT') {
      row.license = 'MIT'; row.evidence = `opencode-ai@${parent.version} platform binary; parent package MIT declaration and THIRD_PARTY_NOTICES.md`;
    }
    if (/MISSING|UNKNOWN|NOASSERTION/i.test(row.license)) throw Error(`Review the production dependency license: ${name}@${item.version}`);
    packages.set(`${name}@${item.version}`, row);
  }
  const dependencies = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return JSON.stringify({ schema: 1, packageLockSHA256: createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex'), scope: 'Production npm dependency declarations, including optional platform packages. Native runtimes, model assets and their notices are documented separately in THIRD_PARTY_NOTICES.md.', dependencies }, null, 2) + '\n';
}
function checkInventory() { if (readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== expectedInventory()) throw Error('Review and regenerate the dependency license inventory after changing the lockfile.'); }
module.exports = { expectedInventory, checkInventory };
if (require.main === module) {
  if (process.argv.includes('--check')) checkInventory(); else writeFileSync(target, expectedInventory());
  console.log('Production dependency license inventory verified against the lockfile.');
}
