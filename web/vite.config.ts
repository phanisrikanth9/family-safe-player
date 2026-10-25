import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Served from https://<user>.github.io/family-safe-player/ on GitHub Pages.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/family-safe-player/',
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 7000 },
})
