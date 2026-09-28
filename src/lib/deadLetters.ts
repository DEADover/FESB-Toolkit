// Очереди ошибок и что с их сообщениями можно сделать.
//
// Отдельного признака «это очередь ошибок» шина не отдаёт: такой очередь
// делают настройки брокера. Узнаётся она по имени — у ActiveMQ это
// `ActiveMQ.DLQ` и `DLQ.<очередь>`, у Artemis `DLQ`, в проектах — `.Error`,
// `.Failed` и тому подобное — и по сообщениям: у попавших туда из-за ошибки
// есть исходная очередь.

import type { ManagerKind, QueueMessage } from '../types'

/** Слова в имени, по которым очередь считается очередью ошибок. */
const ERROR_WORDS = new Set(['dlq', 'dla', 'deadletter', 'error', 'errors', 'err', 'failed', 'failure', 'failures', 'poison'])

export function isErrorQueue(name: string): boolean {
  const lower = name.toLowerCase()
  if (/dead[._\- ]?letter/.test(lower)) return true
  return lower.split(/[^a-z0-9]+/).some((word) => ERROR_WORDS.has(word))
}

/** Сообщение попало сюда из другой очереди — значит, очередь работает как очередь ошибок. */
export function cameFromElsewhere(message: QueueMessage, queue: string): boolean {
  return message.originalQueue !== null && message.originalQueue !== queue
}

export interface OriginGroup {
  /** `null` — брокер не сохранил, откуда пришло сообщение. */
  queue: string | null
  count: number
}

/** Сколько отмеченных сообщений вернётся в какую очередь — для предпросмотра. */
export function groupByOrigin(messages: QueueMessage[]): OriginGroup[] {
  const counts = new Map<string | null, number>()
  for (const message of messages) counts.set(message.originalQueue, (counts.get(message.originalQueue) ?? 0) + 1)
  return [...counts.entries()]
    .map(([queue, count]) => ({ queue, count }))
    .sort((a, b) => (a.queue === null ? 1 : b.queue === null ? -1 : b.count - a.count || a.queue.localeCompare(b.queue)))
}

export type RetryBlock = 'remote' | 'noOrigin'

/**
 * Почему переотправка невозможна, или `null`, если можно.
 *
 * Удалённый менеджер переотправлять не умеет вовсе, а сообщение без
 * исходной очереди брокеру некуда возвращать — его можно только переложить.
 */
export function retryBlock(kind: ManagerKind, messages: QueueMessage[]): RetryBlock | null {
  if (kind === 'RQMS') return 'remote'
  if (messages.some((message) => message.originalQueue === null)) return 'noOrigin'
  return null
}
