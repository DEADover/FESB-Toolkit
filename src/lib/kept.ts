import { invoke } from '@tauri-apps/api/core'

/**
 * Настройки, которые нельзя терять: профили подключений, язык, тема, фоновое слежение.
 *
 * Живут они в хранилище WebView, но оно отдельно от приложения, и после
 * обновления или сбоя WebView может оказаться пустым. Поэтому каждая запись
 * дублируется в файл в папке данных приложения, а при запуске всё, чего в
 * хранилище нет, возвращается из файла.
 */
export const KEPT_KEYS = ['fesb.connections', 'fesb.language', 'fesb.theme', 'fesb.watch'] as const
export type KeptKey = (typeof KEPT_KEYS)[number]

/** Дольше ждать файл незачем: без него приложение всё равно запустится. */
const RESTORE_TIMEOUT_MS = 1500

/** Записывает настройку и её копию на диске. */
export function keep(key: KeptKey, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* хранилище недоступно — останется копия */ }
  invoke('settings_write', { key, value }).catch(() => { /* вне приложения копии нет */ })
}

/**
 * Сверяет хранилище с копией до первой отрисовки.
 *
 * Пропавшее в хранилище берётся из файла; то, что есть только в хранилище
 * (первый запуск версии с копией), дописывается в файл. Если есть и там и
 * там, верным считается хранилище: оно пишется первым.
 */
export async function restoreKept(): Promise<void> {
  let saved: Record<string, string>
  try {
    const answer = await Promise.race([
      invoke<Record<string, string>>('settings_read'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), RESTORE_TIMEOUT_MS)),
    ])
    if (!answer || typeof answer !== 'object') return
    saved = answer
  } catch {
    return
  }
  for (const key of KEPT_KEYS) {
    let current: string | null = null
    try { current = localStorage.getItem(key) } catch { /* нет хранилища */ }
    const copy = typeof saved[key] === 'string' ? saved[key] : null
    if (current === null && copy !== null) {
      try { localStorage.setItem(key, copy) } catch { /* нет хранилища */ }
    } else if (current !== null && current !== copy) {
      invoke('settings_write', { key, value: current }).catch(() => {})
    }
  }
}
