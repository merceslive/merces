import { defineConfig } from 'vite';
export default defineConfig({
  server: { port: 5261, proxy: { '/api': 'http://127.0.0.1:8791', '/i': 'http://127.0.0.1:8791' } },
  build: { target: 'es2022', assetsInlineLimit: 0 },
});
