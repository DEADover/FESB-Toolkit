/**
 * Ошибки, которые приходят от бэкенда.
 *
 * Живут отдельно от моста к Tauri: разбор строки — не работа моста,
 * а без этого их нельзя было бы проверить тестом, не поднимая всё окружение
 * приложения.
 */

import { translate, type MessageKey } from '../i18n'

/** Понятный текст для ошибки, прилетевшей из команды Tauri. */
export function errorText(error: unknown): string {
  const raw = typeof error === 'string' ? error
    : error instanceof Error ? error.message
    // `undefined` в JSON не сериализуется — `stringify` вернул бы его же,
    // и разбор упал бы уже внутри обработчика ошибки.
    : JSON.stringify(error) ?? String(error)
  return readable(raw)
}

/**
 * Разбирает ошибку с кодом от бэкенда.
 *
 * Бэкенд отдаёт частые отказы строкой JSON вида `{"code":…,"detail":…}` —
 * так удалось перевести то, что человек видит чаще всего, не переписывая
 * под коды каждое сообщение в приложении. Всё, что кодом не оказалось,
 * показывается как есть: соврать про чужую ошибку хуже, чем оставить
 * её английской.
 *
 * Подробность не переводится намеренно: это ответ чужой системы.
 */
export function readable(raw: string): string {
  if (!raw.startsWith('{')) return raw
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  if (typeof parsed !== 'object' || parsed === null) return raw
  const { code, detail } = parsed as { code?: unknown; detail?: unknown }
  if (typeof code !== 'string') return raw
  const key = `error.${code}` as MessageKey
  const text = translate(key)
  // Незнакомый код перевести нечем — тогда полезнее подробность.
  if (text === key) return typeof detail === 'string' && detail ? detail : raw
  return typeof detail === 'string' && detail ? `${text}: ${detail}` : text
}
