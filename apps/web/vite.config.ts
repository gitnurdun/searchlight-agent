import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:4321' },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, '../../dist/web'),
    emptyOutDir: true,
  },
});
