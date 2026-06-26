import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Vite configuration for the mobile-first React SPA.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
