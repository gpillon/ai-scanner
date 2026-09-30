import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The backend serves the built UI under /ui/ (see configureApp in src/app.setup.ts).
// In development Vite serves it and forwards /api to the backend.
export default defineConfig({
  base: '/ui/',
  plugins: [react()],
  // PatternFly is most of the bundle; one chunk is fine for an internal tool.
  build: { chunkSizeWarningLimit: 1024 },
  server: {
    port: 5173,
    proxy: { '/api': process.env.SCANNER_API_URL ?? 'http://localhost:3000' },
  },
});
