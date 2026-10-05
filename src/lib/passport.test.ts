import { describe, expect, it } from 'vitest'

import type { Translate } from '../i18n'
import type { ApiEndpoint } from '../types'
import { buildSheets, daysLeft, formatDate, passportFileName, type PassportData, type PassportSection } from './passport'

const t = ((key: string, values?: Record<string, string | number>) => {
  if (values) return `${key}(${Object.values(values).join(',')})`
  return key
}) as Translate

const point = (routeId: string, direction: 'in' | 'out', uri: string): ApiEndpoint => ({
  domain: 'Orders', domainGuid: 'domain-1', route: 'Orders.In', routeId, component: '', direction, kind: 'HTTP',
  scheme: 'jetty', uri, host: null, port: 8080, manager: null, ssl: false, protocol: null, ciphers: null, auth: null,
  state: null, listening: true, uptime: null, busyThreads: null, utilizedThreads: null, readyThreads: null,
  minThreads: null, maxThreads: null, queueSize: null, idleTimeout: null, idleThreads: null,
})

function data(): PassportData {
  return {
    builtAt: '2026-10-05T13:05:04',
    stand: { name: 'Тест', url: 'http://esb.corp:8181/manager', user: 'root' },
    usage: { version: '8.6.524' } as PassportData['usage'],
    walk: {
      domains: [{ guid: 'domain-1', name: 'Orders', description: 'CR 101', tags: null, group: null, routes: 2 }],
      routes: [
        { domainGuid: 'domain-1', domain: 'Orders', id: 'route-1', name: 'Orders.In', description: 'Приём', steps: 4, transacted: false },
        { domainGuid: 'domain-1', domain: 'Orders', id: 'route-9', name: 'Orders.Draft', description: null, steps: 1, transacted: true },
      ],
      endpoints: [point('route-1', 'in', 'jetty:http://0.0.0.0:8080/orders'), point('route-1', 'out', 'https://sap.corp/api')],
      links: [{ fromDomain: 'Orders', fromRoute: 'Orders.In', toDomain: 'Orders', toRoute: 'Orders.Save', uri: 'direct:Save', kind: 'call' }],
    },
    stats: [{ guid: 'domain-1', name: 'Orders', active: true, routes: 2, running: 1, success: 0, errors: 0, inflight: 0 }],
    routes: [{
      id: 'route-1', name: 'Orders.In', domain: 'Orders', domainGuid: 'domain-1', state: 'Started', trace: true,
      traceBeans: ['TraceToQueue'], processed: 10, failed: 1, failuresHandled: 0, inflight: 0, minMs: null, meanMs: null,
      maxMs: null, lastProcessed: '2026-10-05T12:00:00', tags: [],
    }],
    constants: [
      { scope: 'application', domain: null, key: 'url.sap', value: 'https://sap.corp', secured: false, vault: false, empty: false, description: null },
      { scope: 'domain-1', domain: 'Orders', key: 'password', value: '*****', secured: true, vault: false, empty: false, description: null },
    ],
    queues: [{
      manager: { kind: 'QME', id: 'EQM', broker: 'QME:EQM', status: 'RUNNING', running: true, autoStart: true },
      rows: [
        { name: 'Orders.In', address: null, messages: 3, consumers: 1, producers: null, enqueued: null, dequeued: null, internal: false, paused: false, durable: true },
        { name: 'activemq.notifications', address: null, messages: 0, consumers: 0, producers: null, enqueued: null, dequeued: null, internal: true, paused: false, durable: true },
      ],
    }],
    certificates: null,
    modules: null,
    failures: [{ section: 'certificates', error: 'HTTP 403' }],
    warnings: [],
  }
}

const ALL = new Set<PassportSection>(['domains', 'routes', 'links', 'endpoints', 'queues', 'constants', 'certificates'])

describe('buildSheets', () => {
  const sheets = buildSheets(data(), ALL, t, new Date('2026-10-05T00:00:00').getTime())
  const sheet = (name: string) => sheets.find((item) => item.name === name)!

  it('сводка первой, несобранный раздел — без листа, но с причиной в сводке', () => {
    expect(sheets[0].name).toBe('passport.sheet.summary')
    expect(sheets.map((item) => item.name)).not.toContain('passport.section.certificates')
    expect(sheets[0].rows).toContainEqual(['passport.summary.failed(passport.section.certificates)', 'HTTP 403'])
    expect(sheets[0].rows).toContainEqual(['passport.summary.version', '8.6.524'])
  })

  it('СОПС: состояние из списка сервера, входы и выходы из точек, незагруженный — так и сказано', () => {
    const routes = sheet('passport.section.routes')
    const first = routes.rows[0]
    expect(first.slice(0, 4)).toEqual(['Orders', 'Orders.In', 'Приём', 'passport.state.started'])
    expect(first[6]).toBe('HTTP jetty:http://0.0.0.0:8080/orders')
    expect(first[7]).toBe('HTTP https://sap.corp/api')
    expect(routes.rows[1][3]).toBe('passport.state.notDeployed')
    expect(routes.rows.every((row) => row.length === routes.headers.length)).toBe(true)
  })

  it('скрытая константа выгружается без значения', () => {
    const constants = sheet('passport.section.constants')
    expect(constants.rows[1]).toEqual(['passport.scope.domain', 'Orders', 'password', 'passport.hidden', ''])
  })

  it('служебные очереди в паспорт не идут', () => {
    expect(sheet('passport.section.queues').rows.map((row) => row[2])).toEqual(['Orders.In'])
  })

  it('связь подписана словами', () => {
    expect(sheet('passport.section.links').rows[0][4]).toBe('passport.link.call')
  })
})

describe('мелочи', () => {
  it('даты по-русски, остаток дней', () => {
    expect(formatDate('2026-10-05T13:05:04')).toBe('05.10.2026 13:05')
    expect(formatDate('2035-03-23')).toBe('23.03.2035')
    expect(formatDate(null)).toBe('')
    expect(daysLeft('2026-10-15T00:00:00', new Date('2026-10-05T00:00:00').getTime())).toBe(10)
  })

  it('имя файла — по хосту стенда', () => {
    expect(passportFileName('http://esb.corp:8181/manager', '2026-10-05-1305')).toBe('fesb-passport-esb.corp-2026-10-05-1305.xlsx')
  })
})
