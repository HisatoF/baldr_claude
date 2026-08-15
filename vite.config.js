import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '127.0.0.1', port: 5173 },
  build: { target: 'es2022', outDir: 'dist', sourcemap: true },
  // three is large; keeping it a separate chunk keeps game-code rebuilds fast.
  optimizeDeps: { include: ['three'] },
});
