import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { DEFAULT_REMOTE_RELAY_URL } from './src/shared/remote-config';

export default defineConfig({
  main: { define: { 'process.env.TINYGPT_REMOTE_RELAY_URL': JSON.stringify(process.env.TINYGPT_REMOTE_RELAY_URL || DEFAULT_REMOTE_RELAY_URL) }, plugins: [externalizeDepsPlugin({ exclude: ['@fontsource/inter', '@fontsource-variable/figtree', 'remark-gfm'] })], build: { rollupOptions: { input: { index: resolve('src/main/index.ts'), 'chat-worker': resolve('src/main/chat-worker.ts'), 'embedding-worker': resolve('src/main/embedding-worker.ts'), 'file-worker': resolve('src/main/file-worker.ts'), 'moonshine-worker': resolve('src/main/moonshine-worker.ts') } } } },
  preload: { plugins: [externalizeDepsPlugin()], build: {rollupOptions:{input:{index:resolve('src/preload/index.ts'),passwords:resolve('src/preload/passwords.ts')}}} },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: { '@': resolve('src/renderer') } },
    plugins: [react(), tailwindcss()],
    server: { host: '127.0.0.1', port: 5185, strictPort: true, fs: {allow:[resolve('.'),realpathSync(resolve('node_modules'))]} },
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
});
