import { describe, expect, it } from 'vitest'

import type { HealthCheck } from './health'
import { newAlerts } from './watch'

const check = (id: HealthCheck['id'], items: string[], level: HealthCheck['level'] = items.length ? 'warn' : 'ok'): HealthCheck =>
  ({ id, level, count: items.length, samples: items.slice(0, 3), items, screen: 'api.domains' })

describe('фоновое наблюдение', () => {
  it('первая проверка молчит — старое видно в сводке', () => {
    const { alerts } = newAlerts(null, [check('domains', ['A', 'B'])])
    expect(alerts).toEqual([])
  })

  it('сообщает только новое', () => {
    const first = newAlerts(null, [check('domains', ['A'])])
    const second = newAlerts(first.seen, [check('domains', ['A', 'B']), check('certificates', ['tls'])])
    // Сертификаты в прошлый раз не видели вовсе — с ними сравнить не с чем.
    expect(second.alerts).toEqual([{ id: 'domains', items: ['B'] }])
    const third = newAlerts(second.seen, [check('domains', ['A', 'B']), check('certificates', ['tls', 'sap'])])
    expect(third.alerts).toEqual([{ id: 'certificates', items: ['sap'] }])
  })

  it('починенное и снова сломанное — снова новость', () => {
    const one = newAlerts(null, [check('domains', ['A'])])
    const two = newAlerts(one.seen, [check('domains', [])])
    const three = newAlerts(two.seen, [check('domains', ['A'])])
    expect(three.alerts).toEqual([{ id: 'domains', items: ['A'] }])
  })

  it('сбой проверки не превращает старые беды в новые', () => {
    const one = newAlerts(null, [check('queues', ['q1'])])
    const two = newAlerts(one.seen, [check('queues', [], 'unknown')])
    expect(two.alerts).toEqual([])
    const three = newAlerts(two.seen, [check('queues', ['q1'])])
    expect(three.alerts).toEqual([])
  })

  it('СОПС и обмены в фоне не наблюдаются', () => {
    const one = newAlerts(null, [check('routes', [])])
    expect(newAlerts(one.seen, [check('routes', ['r'])]).alerts).toEqual([])
  })
})
