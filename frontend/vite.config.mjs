import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const isDev = mode === 'development'

  return {
    plugins: [react()],
    base: '/',
    build: {
      outDir: '../static',
      emptyOutDir: true,
      assetsDir: 'assets'
    },
    server: isDev
      ? {
          proxy: {
            '/': {
              target: 'http://localhost:8000',
              changeOrigin: true,
              secure: false
            },
            '/ws': {
              target: 'ws://localhost:8000',
              ws: true,
              changeOrigin: true,
              configure: (proxy) => {
                proxy.on('error', (err) => {
                  console.log('WebSocket proxy error:', err)
                })
                proxy.on('proxyReq', (proxyReq, req) => {
                  console.log('WebSocket proxy request:', req.url)
                })
                proxy.on('proxyReqWs', (proxyReq, req) => {
                  console.log('WebSocket proxy request (WS):', req.url)
                })
              }
            }
          }
        }
      : undefined
  }
})