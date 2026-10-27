import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // 127.0.0.1, not localhost: in personal mode the backend binds IPv4 loopback only.
      '/api': 'http://127.0.0.1:3000',
    },
  },
})
