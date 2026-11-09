import { execFileSync } from 'node:child_process';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const project = resolve(fileURLToPath(new URL('..', import.meta.url))), target = resolve(process.argv[2] || '.');
const cli = join(project, 'node_modules/secretlint/bin/secretlint.js');
const args = [cli, '--secretlintrc', join(project, '.secretlintrc.json'), '--format', 'json', target.replaceAll('\\', '/') + '/**/*'];
let output;
try { output = execFileSync(process.execPath, args, { cwd: project, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }); }
catch (error) { if (!error.stdout) throw Error('Secret scanner could not run.'); output = String(error.stdout); }
const rows = JSON.parse(output), findings = rows.flatMap(row => (row.messages || []).map(message => ({ file: relative(target, row.filePath), line: message.loc?.start?.line, rule: message.ruleId })));
if (!rows.length) throw Error('Secret scanner did not inspect any files.');
console.log(JSON.stringify({ files: rows.length, findings }, null, 2));
if (findings.length) process.exitCode = 1;
