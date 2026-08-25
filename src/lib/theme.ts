import { getCurrentWindow } from '@tauri-apps/api/window'

export type ThemeMode = 'system' | 'light' | 'dark'

/** Фон нативного окна: иначе при холодном старте на миг видно чужой цвет. */
const WINDOW_BACKGROUND: Record<'light' | 'dark', [number, number, number]> = {
  dark: [11, 15, 23],
  light: [238, 241, 246],
}

const STORAGE_KEY = 'fesb.theme'

export function readThemeMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
}

export function storeThemeMode(mode: ThemeMode): void {
  localStorage.setItem(STORAGE_KEY, mode)
}

export function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Ставит на <html> итоговую тему; режим `system` следует за настройкой ОС. */
export function applyThemeMode(mode: ThemeMode): 'light' | 'dark' {
  const resolved = mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode
  document.documentElement.dataset.theme = resolved
  try {
    void getCurrentWindow().setBackgroundColor(WINDOW_BACKGROUND[resolved]).catch(() => {})
  } catch {
    // Вне окна Tauri (например, страница открыта в обычном браузере) — не критично.
  }
  return resolved
}
