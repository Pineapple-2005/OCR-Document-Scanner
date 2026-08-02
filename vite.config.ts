import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      manifest: {
        name: 'LocalScan', short_name: 'LocalScan', display: 'standalone',
        start_url: '/', theme_color: '#173b3a', background_color: '#f4f5f2',
        description: 'Private, local-first document scanning.'
      },
      workbox: { navigateFallback: '/index.html', globPatterns: ['**/*.{js,css,html,svg,png,ico}'] }
    })
  ],
})
