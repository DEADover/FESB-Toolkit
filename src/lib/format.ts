/** Числа, которые показывают человеку: размеры и промежутки времени. */

/** `1112926952` → `1.0 GB`. Больше одного знака после запятой здесь не читается. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

/**
 * Промежуток времени двумя крупнейшими единицами: `2 дн. 20 ч`.
 *
 * Точность ниже минуты здесь не нужна: это ответ на вопрос «давно ли»,
 * а не на «сколько именно». Единицы переводятся, потому что «2 д 20 ч»
 * по-русски выглядит телеграммой.
 */
export function formatUptime(
  ms: number,
  t: (key: 'server.days' | 'server.hours' | 'server.minutes', values: { count: number }) => string,
): string {
  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${t('server.days', { count: days })} ${t('server.hours', { count: hours % 24 })}`
  if (hours > 0) return `${t('server.hours', { count: hours })} ${t('server.minutes', { count: minutes % 60 })}`
  return t('server.minutes', { count: minutes })
}

/** Доля 0..1 в проценты: `0.2` → `20%`. */
export function formatShare(value: number): string {
  return `${Math.round(value * 100)}%`
}

/**
 * Сколько ещё ждать — по тому, сколько уже прошло.
 *
 * Оценка грубая и другой быть не может: домены выкачиваются неравномерно,
 * и первые секунды врут сильнее всего. Поэтому она показывается только
 * когда сделана десятая часть работы, округляется до пятёрки секунд
 * и подписана «примерно». Меньше пяти секунд не показывается вовсе:
 * там точность оценки уже меньше, чем время, которое она называет.
 */
export function formatEta(
  elapsedMs: number,
  current: number,
  total: number,
  t: (key: 'job.eta.seconds' | 'job.eta.minutes', values: { count: number }) => string,
): string | null {
  if (total <= 0 || current <= 0 || current >= total) return null
  if (current / total < 0.1) return null

  const remaining = (elapsedMs / current) * (total - current)
  if (remaining < 5000) return null
  if (remaining < 90_000) return t('job.eta.seconds', { count: Math.round(remaining / 5000) * 5 })
  return t('job.eta.minutes', { count: Math.round(remaining / 60_000) })
}
