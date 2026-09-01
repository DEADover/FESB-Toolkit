import { describe, expect, it } from 'vitest'

import type { DomainRecord, RouteInfo, TraceBean } from '../types'
import {
  buildGroups, countRoutes, domainSummary, filterGroups, matchesRouteFilter, namedBroker,
  tracedByDefault, withoutBroker,
  type Filters,
} from './rows'

function bean(id: string, broker: string | null, kind: TraceBean['kind'] = 'queue'): TraceBean {
  return {
    beanId: id, beanName: id, broker, queue: broker === null ? null : 'Mon.Trace',
    clientType: null, traceMode: 'ASYNC', kind, blocking: null, line: 1,
    brokerEditable: broker !== null, queueEditable: broker !== null, traceModeEditable: true,
  }
}

function route(name: string, traceEnabled: boolean, traceConfigs: string[] = []): RouteInfo {
  return { id: `route-${name}`, name, traceEnabled, traceConfigs, inlineTraceConfig: false, file: `${name}.xml` }
}

function domain(name: string, traces: TraceBean[], routes: RouteInfo[]): DomainRecord {
  return {
    id: name, dirPath: `/c/${name}`, dirName: name, domainXmlPath: `/c/${name}/domain.xml`,
    settingsPath: null, domainName: name, guid: name, description: null, startActive: true,
    startMode: 'AUTO', hidden: false, traces, routes, errors: [],
  }
}

/** Домены с разными случаями: обычный, «в память», без объектов вовсе. */
const DOMAINS = [
  domain('EDI.Alfresco', [bean('TraceToQueue', 'QME:EQM'), bean('conf.trace.General', null, 'memory')], [
    route('Alfresco.Get', true, ['TraceToQueue']),
    route('Alfresco.Idle', false),
  ]),
  domain('EDI.Tessa', [bean('TraceToQueue', 'QME:EQM')], [
    route('Status.REST.In', true),
    route('T1.WS.In', true, ['TraceToQueue']),
  ]),
  domain('FESB.LoadTest', [], [route('LoadTest', true)]),
]

const ALL: Filters = { query: '', broker: 'all', onlyEditable: false, onlyChanged: false, routes: 'all' }

describe('tracedByDefault', () => {
  it('это СОПС с включённой трассировкой и без названного объекта', () => {
    expect(tracedByDefault(route('a', true))).toBe(true)
    expect(tracedByDefault(route('b', true, ['TraceToQueue']))).toBe(false)
    expect(tracedByDefault(route('c', false))).toBe(false)
  })

  it('своя конфигурация в файле — это не умолчание', () => {
    expect(tracedByDefault({ ...route('d', true), inlineTraceConfig: true })).toBe(false)
  })
})

describe('matchesRouteFilter', () => {
  it('«все» пропускает любой СОПС', () => {
    expect(matchesRouteFilter(route('a', false), 'all')).toBe(true)
    expect(matchesRouteFilter(route('b', true, ['X']), 'all')).toBe(true)
  })

  it('отбор берёт ровно то, что обещает', () => {
    expect(matchesRouteFilter(route('a', false), 'untraced')).toBe(true)
    expect(matchesRouteFilter(route('b', true), 'untraced')).toBe(false)
    expect(matchesRouteFilter(route('c', true), 'default')).toBe(true)
    expect(matchesRouteFilter(route('d', true, ['X']), 'default')).toBe(false)
  })
})

describe('countRoutes', () => {
  it('считает СОПС домена по выбранному вопросу', () => {
    expect(countRoutes(DOMAINS[0], 'untraced')).toBe(1)
    expect(countRoutes(DOMAINS[0], 'default')).toBe(0)
    expect(countRoutes(DOMAINS[1], 'default')).toBe(1)
    expect(countRoutes(DOMAINS[2], 'default')).toBe(1)
  })
})

describe('filterGroups', () => {
  const groups = buildGroups({ root: '/c', fesbVersion: null, scannedAt: '', durationMs: 0, domains: DOMAINS })

  it('без фильтров показывает всё, включая домен без объектов', () => {
    expect(filterGroups(groups, ALL, new Set()).map((g) => g.domain.domainName))
      .toEqual(['EDI.Alfresco', 'EDI.Tessa', 'FESB.LoadTest'])
  })

  it('отбор по СОПС с трассировкой по умолчанию оставляет только такие домены', () => {
    const found = filterGroups(groups, { ...ALL, routes: 'default' }, new Set())
    expect(found.map((g) => g.domain.domainName)).toEqual(['EDI.Tessa', 'FESB.LoadTest'])
  })

  it('«без брокера» оставляет объекты без брокера, а не домены без объектов', () => {
    const found = filterGroups(groups, { ...ALL, broker: 'none' }, new Set())
    expect(found.map((g) => g.domain.domainName)).toEqual(['EDI.Alfresco'])
    // Домен приходит уже суженным до тех объектов, которые искали.
    expect(found[0].entries.map((entry) => entry.trace.beanId)).toEqual(['conf.trace.General'])
  })

  it('отбор по конкретному брокеру не задевает соседние объекты', () => {
    const found = filterGroups(groups, { ...ALL, broker: 'QME:EQM' }, new Set())
    expect(found.map((g) => g.domain.domainName)).toEqual(['EDI.Alfresco', 'EDI.Tessa'])
    expect(found[0].entries).toHaveLength(1)
  })
})

describe('namedBroker', () => {
  it('пустое свойство — это не названный брокер', () => {
    expect(namedBroker(bean('a', ''))).toBeNull()
    expect(namedBroker(bean('b', '   '))).toBeNull()
    expect(namedBroker(bean('c', null))).toBeNull()
    expect(namedBroker(bean('d', 'QME:EQM'))).toBe('QME:EQM')
  })

  it('и в сводке он не считается за названный', () => {
    const withEmpty = [domain('X', [bean('TraceToQueue', '')], [])]
    expect(domainSummary(withEmpty).withBroker).toBe(0)
    expect(withoutBroker(buildGroups({ root: '/c', fesbVersion: null, scannedAt: '', durationMs: 0, domains: withEmpty }))).toBe(1)
  })
})

describe('withoutBroker и сводка', () => {
  const groups = buildGroups({ root: '/c', fesbVersion: null, scannedAt: '', durationMs: 0, domains: DOMAINS })

  it('считает объекты без брокера, а не домены', () => {
    expect(withoutBroker(groups)).toBe(1)
  })

  it('сводка знает, сколько СОПС трассируется по умолчанию', () => {
    const summary = domainSummary(DOMAINS)
    expect(summary.tracedRoutes).toBe(4)
    expect(summary.defaultTraced).toBe(2)
  })
})
