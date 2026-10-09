import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev:ui` serves the client with hot reload and proxies the API and live sockets (/parties)
// to `wrangler dev` on :8787.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8787', ws: true, changeOrigin: false },
      '/parties': { target: 'http://localhost:8787', ws: true, changeOrigin: false },
    },
  },
});
