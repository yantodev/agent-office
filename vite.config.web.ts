import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/web/client',
  base: '/',
  plugins: [react()],
  build: {
    outDir: '../../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: 'http://127.0.0.1:8787', ws: true },
      '/healthz': 'http://127.0.0.1:8787',
    },
  },
})
