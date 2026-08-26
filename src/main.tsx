import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import { I18nProvider } from './i18n'
import { StatusProvider } from './lib/status'
import { applyThemeMode, readThemeMode } from './lib/theme'
import './index.css'

// Тема ставится до первой отрисовки, иначе на секунду мигает чужой фон.
applyThemeMode(readThemeMode())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <StatusProvider>
        <App />
      </StatusProvider>
    </I18nProvider>
  </StrictMode>,
)
