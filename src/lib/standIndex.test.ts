import { describe, expect, it } from 'vitest'

import { buildIndex, searchIndex } from './standIndex'
import type { ApiDomain, QueueManager, QueueRow, RouteSummary, SweepRow } from '../types'

const domain = (name: string) => ({ guid: `g-${name}`, name }) as ApiDomain
const route = (name: string, domainName: string) =>
  ({ id: `id-${name}`, name, domain: domainName, domainGuid: `g-${domainName}` }) as RouteSummary
const constant = (key: string, value: string, scope = 'application', secured = false) =>
  ({ key, value, scope, domain: scope === 'application' ? null : 'Orders', secured }) as SweepRow
const manager = { kind: 'QMS', id: 'QM', broker: 'QMS:QM' } as QueueManager
const queue = (name: string, internal = false) => ({ name, internal }) as QueueRow

const LABELS = { application: 'Приложение', broker: 'Брокер' }

const index = buildIndex({
  domains: [domain('Orders'), domain('Invoices')],
  routes: [route('Orders.Receive', 'Orders'), route('SendInvoice', 'Invoices')],
  constants: [
    constant('url.orders', 'http://orders.local'),
    constant('db.password', 'orders-secret', 'g-Orders', true),
  ],
  queues: [{ manager, queues: [queue('Orders.In'), queue('DLQ', true)] }],
}, LABELS)

describe('указатель стенда', () => {
  it('собирает домены, СОПС, константы и очереди, без служебных очередей', () => {
    expect(index.map((entry) => entry.kind)).toEqual(['domain', 'domain', 'route', 'route', 'constant', 'constant', 'queue'])
  })

  it('ведёт в нужное место: СОПС — к схеме в своём домене, очередь — к своему менеджеру', () => {
    expect(index.find((entry) => entry.label === 'SendInvoice')?.focus).toEqual({ screen: 'api.routes', guid: 'g-Invoices', route: 'id-SendInvoice' })
    expect(index.find((entry) => entry.label === 'Orders.In')?.focus).toEqual({
      screen: 'api.queues', manager: { kind: 'QMS', id: 'QM' }, query: 'Orders.In',
    })
  })

  it('уровень константы — словами, у доменной — имя домена', () => {
    expect(index.filter((entry) => entry.kind === 'constant').map((entry) => entry.where)).toEqual(['Приложение', 'Orders'])
  })

  it('одна буква — не поиск', () => {
    expect(searchIndex(index, 'o')).toEqual([])
  })

  it('точное имя первым, потом начало имени, потом середина', () => {
    const labels = searchIndex(index, 'orders').map((entry) => entry.label)
    expect(labels[0]).toBe('Orders')
    expect(labels.indexOf('Orders.In')).toBeLessThan(labels.indexOf('url.orders'))
  })

  it('ищет по значению константы, но не по секретному', () => {
    expect(searchIndex(index, 'orders.local').map((entry) => entry.label)).toEqual(['url.orders'])
    expect(searchIndex(index, 'secret')).toEqual([])
  })

  it('не больше заданного числа строк каждого вида', () => {
    const many = buildIndex({
      domains: Array.from({ length: 20 }, (_, i) => domain(`Orders${i}`)),
      routes: [], constants: [], queues: [],
    }, LABELS)
    expect(searchIndex(many, 'orders', 5)).toHaveLength(5)
  })
})
