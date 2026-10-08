import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { rendererCsp } from './electron/security.mjs';

export default defineConfig(({command}) => ({
  plugins: [react(), {
    name: 'renderer-content-security-policy',
    transformIndexHtml() {
      return [{tag: 'meta', attrs: {'http-equiv': 'Content-Security-Policy', content: rendererCsp(command === 'serve')}, injectTo: 'head-prepend'}];
    },
  }],
  base: './', build: {outDir: 'dist'}, server: {port: 5173, strictPort: true},
}));
