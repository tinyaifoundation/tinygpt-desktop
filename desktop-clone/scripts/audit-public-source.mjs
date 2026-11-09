import { readdir, readFile, lstat, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';

const root = resolve(process.argv[2] || '.'), output = process.argv.find(value => value.startsWith('--report='))?.slice(9);
const excluded = new Set(['.git', 'node_modules', 'out', 'release', 'runtimes', 'artifacts', '.tmp', '.npm-cache', '.tools-smoke-profile', '.test-profile', '.reference', '.code-package']);
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['provider-key', /\b(?:sk-or-v1-[a-f0-9]{40,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{35,}|GOCSPX-[A-Za-z0-9_-]{20,})\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['aws-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['google-key', /\bAIza[A-Za-z0-9_-]{30,}\b/g],
  ['private-profile-path', /[A-Za-z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|Example\b|Alex\b|test\b|user\b|fixture\b)[A-Za-z0-9_.-]+/gi],
  ['credential-assignment', /(?:client_secret|oauth_token|refresh_token|access_token|api_key|password)\s*[=:]\s*["'][A-Za-z0-9_+\/=.-]{24,}["']/gi],
];
const findings = [], files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!excluded.has(entry.name) && !entry.name.endsWith('-profile')) await walk(join(dir, entry.name)); continue; }
    const path = join(dir, entry.name), name = relative(root, path).replaceAll('\\', '/');
    const info = await lstat(path);
    if (info.isSymbolicLink()) { findings.push({ file: name, rule: 'symlink' }); continue; }
    if (/^(?:\.env(?:\..*)?|.*\.(?:sqlite|sqlite3|db|pfx|p12|pem|key|log))$/i.test(entry.name) && !/^\.env\.(?:example|sample)$/.test(entry.name)) findings.push({ file: name, rule: 'private-file-type' });
    if (info.size > 50 * 1024 * 1024) findings.push({ file: name, rule: 'oversized-source-file', bytes: info.size });
    files.push({ path: name, bytes: info.size });
    if (info.size > 12 * 1024 * 1024 || !/\.(?:[cm]?[jt]sx?|json[c]?|md|txt|ya?ml|toml|nsh|ps1|cpp|mm|h|css|html|svg|lock|sh|example)$/.test(name)) continue;
    const body = await readFile(path, 'utf8');
    for (const [rule, pattern] of rules) { pattern.lastIndex = 0; for (const match of body.matchAll(pattern)) findings.push({ file: name, line: body.slice(0, match.index).split('\n').length, rule }); }
  }
}
await walk(root);
const report = { root: root.split(/[\\/]/).at(-1), scannedFiles: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), findings };
if (output) await writeFile(output, JSON.stringify({ ...report, files }, null, 2));
console.log(JSON.stringify(report, null, 2));
if (findings.length) process.exitCode = 1;
