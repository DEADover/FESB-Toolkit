// Сводка по найденному ключу: где обмен сейчас, чем закончился, через какие СОПС прошёл.
//
// Шина не знает бизнес-ключей и не хранит историю обмена целиком — есть
// только следы: строки журнала, сообщения в очередях, висящие обмены. Вывод
// из них — догадка по старшинству признаков, и экран показывает, на чём
// она основана.

import { inErrorQueue as queueOfErrors } from './deadLetters'
import type { KeyLogHit, KeyQueueHit, KeyTrace } from '../types'

export type Outcome = 'deadLetter' | 'running' | 'failed' | 'waiting' | 'done' | 'notFound'

/** Найденное сообщение лежит в очереди ошибок. */
export function inErrorQueue(hit: KeyQueueHit): boolean {
  return queueOfErrors(hit.queue, hit.originalQueue)
}

const isError = (hit: KeyLogHit) => {
  const level = hit.level?.toUpperCase()
  return level === 'ERROR' || level === 'FATAL'
}

/**
 * Чем закончилось — по старшинству признаков.
 *
 * Очередь ошибок говорит сама за себя. Висящий обмен — что работа ещё идёт,
 * и ошибка в журнале тогда может быть от прошлой попытки. Сообщение в
 * обычной очереди ждёт своего потребителя. Одни строки журнала без ошибок —
 * обмен прошёл и ушёл дальше.
 */
export function outcomeOf(trace: KeyTrace): Outcome {
  if (trace.queues.some(inErrorQueue)) return 'deadLetter'
  if (trace.inflight.length > 0) return 'running'
  if (trace.logs.some(isError)) return 'failed'
  if (trace.queues.length > 0) return 'waiting'
  if (trace.logs.length > 0) return 'done'
  return 'notFound'
}

export interface RouteVisit {
  domain: string
  route: string
  domainGuid: string | null
  lines: number
  errors: number
  first: string | null
  last: string | null
}

/** СОПС, которые оставили строки в журнале, — в порядке, в каком обмен через них прошёл. */
export function routesOf(logs: KeyLogHit[]): RouteVisit[] {
  const visits = new Map<string, RouteVisit>()
  for (const hit of logs) {
    if (!hit.route) continue
    const key = `${hit.route.domain}/${hit.route.route}`
    const visit = visits.get(key) ?? {
      domain: hit.route.domain, route: hit.route.route, domainGuid: hit.route.domainGuid,
      lines: 0, errors: 0, first: null, last: null,
    }
    visit.lines += 1
    if (isError(hit)) visit.errors += 1
    if (hit.timestamp) {
      if (!visit.first || hit.timestamp < visit.first) visit.first = hit.timestamp
      if (!visit.last || hit.timestamp > visit.last) visit.last = hit.timestamp
    }
    visits.set(key, visit)
  }
  return [...visits.values()].sort((a, b) => (a.first ?? '').localeCompare(b.first ?? '') || a.route.localeCompare(b.route))
}

export interface QueuePlace {
  broker: string
  queue: string
  count: number
  error: boolean
}

/** Где лежат найденные сообщения: по очередям, очереди ошибок — первыми. */
export function queuePlaces(hits: KeyQueueHit[]): QueuePlace[] {
  const places = new Map<string, QueuePlace>()
  for (const hit of hits) {
    const key = `${hit.broker}/${hit.queue}`
    const place = places.get(key) ?? { broker: hit.broker, queue: hit.queue, count: 0, error: inErrorQueue(hit) }
    place.count += 1
    places.set(key, place)
  }
  return [...places.values()].sort((a, b) => Number(b.error) - Number(a.error) || b.count - a.count || a.queue.localeCompare(b.queue))
}

/** Когда ключ попадался последний раз — в журнале или в очереди. */
export function lastSeen(trace: KeyTrace): string | null {
  const times = [...trace.logs.map((hit) => hit.timestamp), ...trace.queues.map((hit) => hit.timestamp)]
    .filter((time): time is string => Boolean(time))
  return times.length > 0 ? times.reduce((a, b) => (a > b ? a : b)) : null
}
