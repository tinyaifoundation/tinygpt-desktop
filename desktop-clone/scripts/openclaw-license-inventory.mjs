import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'runtimes', 'openclaw');
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const packages = [];
for (const path of Object.keys(lock.packages).sort()) {
  if (!path.startsWith('node_modules/') || lock.packages[path].link) continue;
  try {
    const manifest = JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8'));
    packages.push({ path, name: manifest.name, version: manifest.version, license: manifest.license ?? manifest.licenses?.map(item => item.type).join(' OR ') ?? 'UNDECLARED' });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await writeFile(join(root, 'DEPENDENCY_LICENSES.json'), JSON.stringify({ openclaw: '2026.9.9', target: `${process.platform}-${process.arch}`, source: 'Installed manifests selected by package-lock.json; original license files remain in the resource tree.', packages }, null, 2) + '\n');
const counts = {}; for (const pkg of packages) counts[pkg.license] = (counts[pkg.license] ?? 0) + 1;
console.log(JSON.stringify({ installedPackages: packages.length, licenses: counts }));
