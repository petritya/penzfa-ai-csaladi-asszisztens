import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      filename: 'OneSignalSDKWorker.js',
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        importScripts: [
          'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js',
        ],
      },
      manifest: {
        name: 'AI családi asszisztens',
        short_name: 'AI családi asszisztens',
        description: 'Családi teendők, emlékeztetések és napi briefing egy helyen.',
        theme_color: '#0f172a',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: '/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          }
        ]
      }
    })
  ]
})
