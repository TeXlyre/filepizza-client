import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '../../src/filepizza-client': path.resolve(__dirname, './src/filepizza-client')
    }
  },
  build: {
    outDir: 'dist-example',
    sourcemap: true
  }
});