// Фоновое наблюдение за стендом.
//
// Пока приложение подключено, сводка по стенду перечитывается раз в
// несколько минут, и о новом — упавшем домене, истекающем сертификате,
// очереди, которую перестали разбирать, — говорит системное уведомление.
// Здесь только правило «что считать новым»; опрос и показ — в App.

import type { HealthCheck, HealthId } from './health'

/** Что наблюдается в фоне. Ошибки СОПС и зависшие обмены слишком шумные для уведомлений. */
export const WATCHED: HealthId[] = ['domains', 'certificates', 'queues', 'modules']

/** Как часто перечитывать сводку. */
export const WATCH_INTERVAL_MS = 5 * 60_000

export interface Alert {
  id: HealthId
  /** Новое с прошлой проверки. */
  items: string[]
}

/** Отпечаток сводки: по какому пункту что найдено. */
export type Seen = Map<HealthId, Set<string>>

export function seenOf(checks: HealthCheck[]): Seen {
  const seen: Seen = new Map()
  for (const check of checks) {
    if (!WATCHED.includes(check.id)) continue
    // Непроверенный пункт — не «всё починили»: иначе после сбоя связи
    // старые беды пришли бы уведомлением как новые.
    if (check.level === 'unknown') continue
    seen.set(check.id, new Set(check.items))
  }
  return seen
}

/**
 * Новое по сравнению с прошлой проверкой.
 *
 * Первая проверка ничего не сообщает: то, что было на стенде до начала
 * наблюдения, видно в сводке на «Начале», и две сотни уведомлений об
 * остановленных доменах в первую же минуту никому не нужны. Пункт, который
 * в прошлый раз проверить не удалось, тоже молчит — сравнивать не с чем.
 */
export function newAlerts(previous: Seen | null, checks: HealthCheck[]): { alerts: Alert[]; seen: Seen } {
  const seen = seenOf(checks)
  if (!previous) return { alerts: [], seen }
  const alerts: Alert[] = []
  for (const [id, items] of seen) {
    const before = previous.get(id)
    if (!before) {
      // Не с чем сравнивать — запоминаем и молчим.
      continue
    }
    const fresh = [...items].filter((item) => !before.has(item))
    if (fresh.length > 0) alerts.push({ id, items: fresh })
  }
  // Пункт, который сейчас не проверился, держим прежним — до следующей удачи.
  for (const [id, items] of previous) if (!seen.has(id)) seen.set(id, items)
  return { alerts, seen }
}
