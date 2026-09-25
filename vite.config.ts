import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'

// Версия для dev-preview.html: там нет Tauri и ответ `app_info` — заглушка,
// а номер, вписанный руками, отставал от package.json на несколько релизов.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

// Конфигурация под Tauri: фиксированный порт и отсутствие «шумных» оверлеев.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    { name: 'app-version', transformIndexHtml: (html) => html.replaceAll('__APP_VERSION__', version) },
  ],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
})
