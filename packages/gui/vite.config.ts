import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  // Relative base: HTML references `./assets/...` so the SPA works whether
  // it is served at `/`, `/ui/`, or `/ui/{db}/` (rfdb-server route layer).
  base: './',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  publicDir: 'public',
  build: {
    rollupOptions: {
      input: {
        // Two host entries: dev overlay + production SPA served by rfdb-server.
        // Each gets its own HTML + JS bundle under `dist/`.
        // The VS Code extension iframes `web.html` via rfdb-server's
        // `/ui/{db}` route (see REG-1100); no separate vscode entry.
        index: resolve(__dirname, 'index.html'),
        web: resolve(__dirname, 'web.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api/layout-live': {
        target: 'ws://localhost:3333',
        ws: true,
      },
      '/api/graph-stream': {
        target: 'http://localhost:3333',
        changeOrigin: true,
        // Disable response buffering for streaming NDJSON
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['cache-control'] = 'no-cache';
            delete proxyRes.headers['content-length'];
          });
        },
      },
      '/api': {
        target: 'http://localhost:3333',
        changeOrigin: true,
      },
    },
    fs: {
      allow: ['.'],
    },
  },
});
