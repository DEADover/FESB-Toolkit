import { describe, expect, it } from 'vitest'

import type { RouteSummary } from '../types'
import { beanChoices, beansByDomain, planRouteTrace } from './routeTrace'

function row(id: string, domainGuid: string, trace: boolean, traceBeans: string[]): RouteSummary {
  return {
    id, name: id, domain: domainGuid, domainGuid, state: 'Started', trace, traceBeans,
    processed: 0, failed: 0, failuresHandled: 0, inflight: 0, minMs: null, meanMs: null, maxMs: null,
    lastProcessed: null, tags: [],
  }
}

const ROWS = [
  row('a', 'd1', true, ['TraceToQueue']),
  row('b', 'd1', false, ['TraceToQueue']),
  row('c', 'd2', false, []),
]
const BEANS = beansByDomain([
  { guid: 'd1', beans: [{ name: 'TraceToQueue', kind: 'queue' }, { name: 'MC.TRACE', kind: 'queue' }] },
  { guid: 'd2', beans: [{ name: 'TraceToQueue', kind: 'queue' }] },
])

describe('planRouteTrace', () => {
  it('включение трогает только выключенные СОПС', () => {
    const plan = planRouteTrace(ROWS, { enabled: true, config: null }, BEANS)
    expect(plan.map((item) => item.kind)).toEqual(['unchanged', 'change', 'change'])
  })

  it('не назначает объект, которого нет в домене', () => {
    const plan = planRouteTrace(ROWS, { enabled: null, config: 'MC.TRACE' }, BEANS)
    expect(plan.map((item) => item.kind)).toEqual(['change', 'change', 'missing'])
    expect(plan[2]).toMatchObject({ missing: ['MC.TRACE'] })
  })

  it('«по умолчанию домена» не требует объекта в домене', () => {
    const plan = planRouteTrace(ROWS, { enabled: null, config: '' }, BEANS)
    expect(plan.map((item) => item.kind)).toEqual(['change', 'change', 'unchanged'])
  })
})

it('объекты для выбора идут по числу доменов, где они есть', () => {
  expect(beanChoices([
    { guid: 'd1', beans: [{ name: 'MC.TRACE', kind: 'queue' }, { name: 'TraceToQueue', kind: 'queue' }] },
    { guid: 'd2', beans: [{ name: 'TraceToQueue', kind: 'queue' }] },
  ])).toEqual([{ name: 'TraceToQueue', domains: 2 }, { name: 'MC.TRACE', domains: 1 }])
})
