import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Vite configuration for the mobile-first React SPA.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy API calls to the backend during development so the SPA can use
    // same-origin `/api/...` requests (no CORS, no base-URL config needed).
    // Override the backend target with VITE_BACKEND_URL if it runs elsewhere.
    proxy: {
      '/api': {
        target: process.env['VITE_BACKEND_URL'] ?? 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
