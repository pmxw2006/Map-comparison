import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/media': 'http://127.0.0.1:8000',
    },
  },
  build: {
    // Three.js 是首屏全景渲染核心；609 kB 原始包对应约 166 kB gzip。
    chunkSizeWarningLimit: 650,
  },
})
