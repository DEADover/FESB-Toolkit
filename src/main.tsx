import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import { ToastProvider } from './components/Toaster'
import { I18nProvider } from './i18n'
import { restoreKept } from './lib/kept'
import { applyThemeMode, readThemeMode } from './lib/theme'
import './index.css'

// Сначала — настройки из копии на диске, если хранилище WebView пропало
// (после обновления такое бывает): иначе приложение откроется без подключений.
void restoreKept().finally(() => {
  // Тема ставится до первой отрисовки, иначе на секунду мигает чужой фон.
  applyThemeMode(readThemeMode())

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </I18nProvider>
    </StrictMode>,
  )
})
