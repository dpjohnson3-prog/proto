import { defineConfig } from 'vite';

export default defineConfig({
  // Capacitor serves the built assets from the app bundle, so every URL has to
  // be relative rather than rooted at /.
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: "es2020" },
  server: { host: true, port: 5173 }
});
