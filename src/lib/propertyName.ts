import type { MessageKey, Translate } from '../i18n'

/**
 * Читаемое имя константы из её ключа.
 *
 * Ключи в шине структурные: `const.<вид>.<система>` у доменов и
 * `factor.<подсистема>.<...>` у приложения. Из этого получается название,
 * по которому видно, что за значение перед тобой, — а точный ключ остаётся
 * подписью, потому что именно им константа подставляется в СОПС.
 */

/** Технические приставки, которые есть у всех ключей и ничего не сообщают. */
const PREFIXES = new Set(['const', 'factor', 'fesb'])

/** Первый значимый сегмент переводится, если он нам знаком. */
function head(segment: string, t: Translate): string {
  const key = `property.part.${segment.toLowerCase()}` as MessageKey
  const text = t(key)
  if (text !== key) return text
  const words = humanizeSegment(segment)
  return isIdentifier(segment) ? words : words[0].toUpperCase() + words.slice(1)
}

/**
 * Имя системы, а не слово: `EUT_485_1`, `SAPPI`, `CMDB-366`, `1C`.
 * Такие сегменты трогать нельзя — «улучшенный» `Cmdb 366` перестаёт быть именем.
 */
function isIdentifier(segment: string): boolean {
  return /^[A-Z0-9][A-Z0-9_-]*$/.test(segment)
}

/** `idleTimeout` → `idle timeout`, `scheduler-cache-max` → `scheduler cache max`. */
export function humanizeSegment(segment: string): string {
  if (isIdentifier(segment)) return segment
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
    .toLowerCase() || segment
}

/**
 * Хвост ключа — это одна фраза, а не набор заголовков.
 *
 * `jmx.pool.max.idle` читается как «Jmx pool max idle», а не
 * «Jmx · Pool · Max · Idle»: точки в ключе — просто вложенность настройки.
 */
function tail(segments: string[]): string {
  const words = segments.map(humanizeSegment).join(' ').trim()
  if (!words) return ''
  return isIdentifier(segments[0]) ? words : words[0].toUpperCase() + words.slice(1)
}

export function humanizeKey(key: string, t: Translate): string {
  const parts = key.split('.').filter((part) => part.length > 0)
  if (parts.length === 0) return key
  if (parts.length > 1 && PREFIXES.has(parts[0].toLowerCase())) parts.shift()
  if (parts.length === 0) return key

  const rest = tail(parts.slice(1))
  return rest ? `${head(parts[0], t)} · ${rest}` : head(parts[0], t)
}
