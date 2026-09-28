import { describe, expect, it } from 'vitest'

import { inErrorQueue, lastSeen, outcomeOf, queuePlaces, routesOf } from './keyTrace'
import type { InflightExchange, KeyLogHit, KeyQueueHit, KeyTrace } from '../types'

const log = (time: string, route: string | null, level = 'INFO'): KeyLogHit => ({
  timestamp: time, level, file: 'sops.log', thread: 't', byExchange: false, message: 'text',
  route: route ? { domain: route.split('/')[0], route: route.split('/')[1], domainGuid: null } : null,
})
const queued = (queue: string, originalQueue: string | null = null, time: string | null = null): KeyQueueHit => ({
  kind: 'QMS', manager: 'QM', broker: 'QMS:QM', queue, messageId: `${queue}-1`, timestamp: time,
  originalQueue, excerpt: 'orderNumber = INV-1', inBody: false,
})
const trace = (patch: Partial<KeyTrace>): KeyTrace => ({
  key: 'INV-1', logs: [], logsLimited: false, exchangeIds: [], inflight: [], queues: [],
  queuesChecked: 0, messagesChecked: 0, bodiesSkipped: 0, queuesTruncated: [], problems: [], ...patch,
})
const flying = { id: 'X', route: 'Orders.In' } as InflightExchange

describe('сводка по ключу', () => {
  it('очередь ошибок узнаётся по имени и по исходной очереди', () => {
    expect(inErrorQueue(queued('DLQ.Invoices.In'))).toBe(true)
    expect(inErrorQueue(queued('Orders.Audit', 'Orders.In'))).toBe(true)
    expect(inErrorQueue(queued('Invoices.In'))).toBe(false)
    expect(inErrorQueue(queued('Invoices.In', 'DLQ.Invoices.In'))).toBe(false)
  })

  it('итог выбирается по старшинству признаков', () => {
    expect(outcomeOf(trace({}))).toBe('notFound')
    expect(outcomeOf(trace({ logs: [log('1', 'A/In')] }))).toBe('done')
    expect(outcomeOf(trace({ logs: [log('1', 'A/In')], queues: [queued('Invoices.In')] }))).toBe('waiting')
    expect(outcomeOf(trace({ logs: [log('1', 'A/In', 'ERROR')], queues: [queued('Invoices.In')] }))).toBe('failed')
    expect(outcomeOf(trace({ logs: [log('1', 'A/In', 'ERROR')], inflight: [flying] }))).toBe('running')
    expect(outcomeOf(trace({ inflight: [flying], queues: [queued('DLQ.Invoices.In')] }))).toBe('deadLetter')
  })

  it('СОПС собираются по строкам журнала в порядке прохождения', () => {
    const routes = routesOf([
      log('2026-09-28T10:00:03', 'Billing/Pay'),
      log('2026-09-28T10:00:01', 'Orders/In'),
      log('2026-09-28T10:00:02', 'Orders/In', 'ERROR'),
      log('2026-09-28T10:00:04', null),
    ])
    expect(routes.map((visit) => [visit.route, visit.lines, visit.errors, visit.first, visit.last])).toEqual([
      ['In', 2, 1, '2026-09-28T10:00:01', '2026-09-28T10:00:02'],
      ['Pay', 1, 0, '2026-09-28T10:00:03', '2026-09-28T10:00:03'],
    ])
  })

  it('очереди ошибок в списке мест — первыми', () => {
    expect(queuePlaces([queued('Invoices.In'), queued('Invoices.In'), queued('DLQ.Invoices.In')])).toEqual([
      { broker: 'QMS:QM', queue: 'DLQ.Invoices.In', count: 1, error: true },
      { broker: 'QMS:QM', queue: 'Invoices.In', count: 2, error: false },
    ])
  })

  it('последний раз ключ видели там, где время позже', () => {
    expect(lastSeen(trace({}))).toBeNull()
    expect(lastSeen(trace({
      logs: [log('2026-09-28T10:00:01', 'A/In')],
      queues: [queued('Invoices.In', null, '2026-09-28T10:05:00'), queued('X')],
    }))).toBe('2026-09-28T10:05:00')
  })
})
