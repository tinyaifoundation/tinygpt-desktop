const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { releaseConfigurationIssues } = require('./release-config.cjs');
const root = join(__dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const issues = releaseConfigurationIssues(process.env, process.argv.includes('--ci'));
if (!/^\d+\.\d+\.\d+-prebeta\.\d+$/.test(version)) issues.push('Use a Windows pre-beta version.');
else {
  try { if (readFileSync(join(root, 'release-notes', version + '.md'), 'utf8').trim().length < 40) issues.push('Write release notes before shipping.'); }
  catch { issues.push('Add release-notes/' + version + '.md before shipping.'); }
}
if (issues.length) {
  console.error('Release preparation is incomplete:\n' + issues.map(issue => '- ' + issue).join('\n'));
  process.exitCode = 1;
} else console.log(`TinyGPT ${version}: release configuration is present. The build will still verify actual signatures before publishing.`);
