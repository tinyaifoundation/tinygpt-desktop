import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
export default defineConfig({
  root: resolve('src/renderer'), resolve: { alias: { '@': resolve('src/renderer') } }, plugins: [react(), tailwindcss()],
  build: { outDir: resolve('remote-relay/public'), emptyOutDir: true, rollupOptions: { input: resolve('src/renderer/mobile.html') } },
});
