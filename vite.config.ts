import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // The Rust build writes tens of thousands of files into target/ and deletes
    // them again mid-build; watching it makes the dev server fall over with
    // ENOENT on a fingerprint file. Nothing in there is a frontend source.
    watch: { ignored: ['**/target/**', '**/src-tauri/gen/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'chrome110',
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
