import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  publicDir: 'public',
  server: {
    port: 5173,
    proxy: {
      '/api/graph-stream': {
        target: 'http://localhost:3333',
        changeOrigin: true,
        // Disable response buffering for streaming NDJSON
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            // Prevent http-proxy from buffering the response
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
