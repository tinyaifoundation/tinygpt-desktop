const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { releaseConfigurationIssues } = require('./release-config.cjs');
const root = join(__dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const issues = releaseConfigurationIssues(process.env, process.argv.includes('--ci'));
try {
  const crypto = require('node:crypto');
  const data = JSON.parse(readFileSync(join(root, 'src/shared/update-key.json'), 'utf8'));
  const publicKey = crypto.createPublicKey({ key: Buffer.from(data.publicKey, 'base64'), type: 'spki', format: 'der' });
  if (data.schema !== 1 || data.algorithm !== 'Ed25519' || publicKey.asymmetricKeyType !== 'ed25519') throw Error();
  if (process.argv.includes('--ci') && process.env.TINYGPT_UPDATE_PRIVATE_KEY) {
    const privateKey = crypto.createPrivateKey({ key: Buffer.from(process.env.TINYGPT_UPDATE_PRIVATE_KEY, 'base64'), type: 'pkcs8', format: 'der' });
    if (privateKey.asymmetricKeyType !== 'ed25519' || !crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' }))) throw Error();
  }
} catch { issues.push('Provision the pinned Ed25519 update key and its matching protected release secret.'); }
if (!/^\d+\.\d+\.\d+-prebeta\.\d+$/.test(version)) issues.push('Use a Windows pre-beta version.');
else {
  try { if (readFileSync(join(root, 'release-notes', version + '.md'), 'utf8').trim().length < 40) issues.push('Write release notes before shipping.'); }
  catch { issues.push('Add release-notes/' + version + '.md before shipping.'); }
}
if (issues.length) {
  console.error('Release preparation is incomplete:\n' + issues.map(issue => '- ' + issue).join('\n'));
  process.exitCode = 1;
} else console.log(`TinyGPT ${version}: ${process.env.TINYGPT_RELEASE_SIGNING_MODE || 'windows'} release configuration is present. Publication also requires a valid TinyGPT release-key proof.`);
