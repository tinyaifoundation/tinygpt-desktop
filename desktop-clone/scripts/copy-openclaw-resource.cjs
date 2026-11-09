// extraResources applies node_modules exclusions. Preserve upstream's complete
// installed tree explicitly; its package self-imports and nested npm need it.
const { cp, access } = require('node:fs/promises');
const { join } = require('node:path');
module.exports = async context => {
  const source = join(context.packager.projectDir, 'runtimes/openclaw/node_modules');
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const destination = join(resources, 'openclaw/node_modules');
  await cp(source, destination, { recursive: true, dereference: false });
  for (const path of ['openclaw/openclaw.mjs', 'openclaw/LICENSE', '@openclaw/ai/package.json', 'npm/package.json']) await access(join(destination, path));
};
