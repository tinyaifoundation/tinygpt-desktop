import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connectorSplashIds } from '../src/shared/connector-splashes.ts';
const require = createRequire(import.meta.url);
await mkdir('plugin-auth/public/connector-assets', { recursive: true });
await copyFile(require.resolve('@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2'), 'plugin-auth/public/connector-assets/figtree.woff2');
await copyFile('src/renderer/assets/remote-pair-hero.png', 'plugin-auth/public/connector-assets/hero.png');
for (const id of connectorSplashIds) await copyFile(`src/renderer/assets/connectors/splashes/${id}-v1.webp`, `plugin-auth/public/connector-assets/${id}-v1.webp`);
