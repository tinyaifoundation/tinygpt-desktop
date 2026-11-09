const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { parse } = require('yaml');
const root = join(__dirname, '..');
if (process.platform === 'win32') {
  // The signer launches Windows PowerShell; do not inherit PowerShell 7's module directory.
  process.env.PSModulePath = [join(process.env.USERPROFILE || '', 'Documents/WindowsPowerShell/Modules'), join(process.env.ProgramFiles || 'C:/Program Files', 'WindowsPowerShell/Modules'), join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/Modules')].join(';');
}
const { releaseConfigurationIssues } = require('./release-config.cjs');
const issues = releaseConfigurationIssues(process.env);
if (issues.length) throw Error('Signed release configuration is incomplete:\n' + issues.join('\n'));
function required(name) { return process.env[name].trim(); }
const config = parse(readFileSync(join(root, 'electron-builder.yml'), 'utf8'));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+-prebeta\.\d+$/.test(version)) throw Error('Use a version such as 0.1.0-prebeta.3 for this release channel.');
const endpoint = required('TINYGPT_SIGNING_ENDPOINT');
const publisherName = required('TINYGPT_PUBLISHER_NAME');
config.forceCodeSigning = true;
config.win.publisherName = publisherName;
config.win.azureSignOptions = { publisherName, endpoint, codeSigningAccountName: required('TINYGPT_SIGNING_ACCOUNT'), certificateProfileName: required('TINYGPT_SIGNING_PROFILE') };
config.publish = [{ provider: 'generic', url: `https://downloads.tinygpt.org/releases/${version}` }];
module.exports = config;
