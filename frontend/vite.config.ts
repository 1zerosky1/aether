import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Match the cloudflared tunnel's origin (talked-attribute-...trycloudflare.com → 127.0.0.1:5174).
    host: true,
    port: 5174,
    strictPort: true,
    // Allow the public tunnel hostname to load the dev server (Vite blocks unknown hosts in dev).
    allowedHosts: ['.trycloudflare.com'],
  },
})
