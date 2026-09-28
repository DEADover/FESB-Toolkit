import { describe, expect, it } from 'vitest'

import { cameFromElsewhere, groupByOrigin, isErrorQueue, retryBlock } from './deadLetters'
import type { QueueMessage } from '../types'

const message = (id: string, originalQueue: string | null): QueueMessage => ({
  id, originalQueue, correlationId: null, timestamp: null, priority: null, size: 0, bodySize: 0,
  bodyType: null, persistent: false, redelivered: false, replyTo: null, properties: [], body: null, truncated: false,
})

describe('очереди ошибок', () => {
  it('узнаются по имени у ActiveMQ, Artemis и в проектах', () => {
    for (const name of ['ActiveMQ.DLQ', 'DLQ', 'DLQ.Invoices.In', 'Orders.In.DLQ', 'orders_dlq', 'DeadLetterQueue',
      'dead.letter.orders', 'Orders.Error', 'SAP.Errors', 'Invoices.Failed', 'poison-messages']) {
      expect(isErrorQueue(name), name).toBe(true)
    }
  })

  it('обычные очереди — не очереди ошибок, даже если слово внутри другого', () => {
    for (const name of ['Orders.In', 'Invoices.Retry', 'TerrorReports', 'Erroneous.Imports', 'ExpiryQueue', 'Dlqueue']) {
      expect(isErrorQueue(name), name).toBe(false)
    }
  })

  it('сообщение из другой очереди выдаёт очередь ошибок и без говорящего имени', () => {
    expect(cameFromElsewhere(message('1', 'Orders.In'), 'Orders.Audit')).toBe(true)
    expect(cameFromElsewhere(message('2', 'Orders.Audit'), 'Orders.Audit')).toBe(false)
    expect(cameFromElsewhere(message('3', null), 'Orders.Audit')).toBe(false)
  })

  it('предпросмотр показывает, сколько куда вернётся, неизвестное — последним', () => {
    expect(groupByOrigin([
      message('1', 'Orders.In'), message('2', null), message('3', 'Invoices.In'),
      message('4', 'Orders.In'), message('5', 'Invoices.In'), message('6', 'Orders.In'),
    ])).toEqual([
      { queue: 'Orders.In', count: 3 },
      { queue: 'Invoices.In', count: 2 },
      { queue: null, count: 1 },
    ])
  })

  it('вернуть можно только то, у чего известна исходная очередь, и не на удалённом менеджере', () => {
    const known = [message('1', 'Orders.In'), message('2', 'Invoices.In')]
    expect(retryBlock('QMS', known)).toBeNull()
    expect(retryBlock('QME', known)).toBeNull()
    expect(retryBlock('RQMS', known)).toBe('remote')
    expect(retryBlock('QMS', [...known, message('3', null)])).toBe('noOrigin')
  })
})
