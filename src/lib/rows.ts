import type { DomainRecord, ScanResult, TraceBean } from '../types'

/** Одна трассировка внутри домена. Ключ выделения стабилен между сканированиями. */
export interface TraceEntry {
  key: string
  trace: TraceBean
  index: number
  editable: boolean
}

/** Домен со всеми своими объектами трассировки — строка таблицы верхнего уровня. */
export interface DomainGroup {
  domain: DomainRecord
  entries: TraceEntry[]
}

export function buildGroups(scan: ScanResult | null): DomainGroup[] {
  if (!scan) return []
  return scan.domains.map((domain) => ({
    domain,
    entries: domain.traces.map((trace, index) => ({
      key: `${domain.id}::${index}`,
      trace,
      index,
      editable: trace.brokerEditable || trace.queueEditable || trace.traceModeEditable,
    })),
  }))
}

export type SortKey = 'domain' | 'broker' | 'bean' | 'routes'
export type SortDir = 'asc' | 'desc'

export interface Filters {
  query: string
  broker: string | 'all' | 'none'
  onlyEditable: boolean
  /** Только домены, где есть СОПС с выключенной трассировкой. */
  untracedRoutes: boolean
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function matchesQuery(values: Array<string | null | undefined>, query: string): boolean {
  return values.some((value) => typeof value === 'string' && value.toLowerCase().includes(query))
}

/* --------------------------------- СОПС --------------------------------- */

/** Сколько СОПС в домене и в скольких из них включена трассировка. */
export function routeSummary(domain: DomainRecord) {
  const traced = domain.routes.filter((route) => route.traceEnabled).length
  return { total: domain.routes.length, traced, untraced: domain.routes.length - traced }
}

/** Сколько СОПС домена ссылается на конкретный объект трассировки. */
export function routesUsingBean(domain: DomainRecord, beanId: string | null): number {
  if (!beanId) return 0
  return domain.routes.filter((route) => route.traceEnabled && route.traceConfigs.includes(beanId)).length
}

/* ------------------------------ Фильтрация ------------------------------ */

/**
 * Фильтрует объекты трассировки внутри доменов и убирает домены, где ничего
 * не осталось. Поиск охватывает и СОПС: домен виден, если совпало имя маршрута.
 */
export function filterGroups(groups: DomainGroup[], filters: Filters): DomainGroup[] {
  const query = filters.query.trim().toLowerCase()
  const result: DomainGroup[] = []

  for (const group of groups) {
    if (filters.untracedRoutes && routeSummary(group.domain).untraced === 0) continue

    const domainMatches = !query || matchesQuery(
      [
        group.domain.domainName, group.domain.description, group.domain.guid, group.domain.dirName,
        ...group.domain.routes.flatMap((route) => [route.name, route.id, ...route.traceConfigs]),
      ],
      query,
    )

    if (group.entries.length === 0) {
      const brokerFilterOff = filters.broker === 'all' || filters.broker === 'none'
      if (brokerFilterOff && !filters.onlyEditable && domainMatches) result.push(group)
      continue
    }

    const entries = group.entries.filter((entry) => {
      const broker = entry.trace.broker
      if (filters.broker === 'none' && broker !== null) return false
      if (filters.broker !== 'all' && filters.broker !== 'none' && broker !== filters.broker) return false
      if (filters.onlyEditable && !entry.editable) return false
      if (!query) return true
      return domainMatches
        || matchesQuery([entry.trace.beanId, entry.trace.queue, entry.trace.traceMode, broker], query)
    })

    if (entries.length > 0) result.push({ domain: group.domain, entries })
  }

  return result
}

export function sortGroups(groups: DomainGroup[], key: SortKey, dir: SortDir): DomainGroup[] {
  const factor = dir === 'asc' ? 1 : -1
  if (key === 'routes') {
    return [...groups].sort((a, b) => (a.domain.routes.length - b.domain.routes.length) * factor
      || collator.compare(a.domain.domainName, b.domain.domainName))
  }
  const value = (group: DomainGroup): string => {
    switch (key) {
      // У домена может быть несколько объектов трассировки — берём первый.
      case 'broker': return group.entries[0]?.trace.broker ?? '￿'
      case 'bean': return group.entries[0]?.trace.beanId ?? '￿'
      default: return group.domain.domainName
    }
  }
  return [...groups].sort((a, b) => {
    const cmp = collator.compare(value(a), value(b))
    return (cmp !== 0 ? cmp : collator.compare(a.domain.domainName, b.domain.domainName)) * factor
  })
}

export function selectableKeys(groups: DomainGroup[]): string[] {
  return groups.flatMap((group) => group.entries.filter((e) => e.editable).map((e) => e.key))
}

/* -------------------------- Значения для подсказок -------------------------- */

function distinct(groups: DomainGroup[], pick: (trace: TraceBean) => string | null): string[] {
  const set = new Set<string>()
  for (const group of groups) {
    for (const entry of group.entries) {
      const value = pick(entry.trace)
      if (value) set.add(value)
    }
  }
  return [...set].sort(collator.compare)
}

/** Значения брокера с количеством вхождений, по убыванию частоты. */
export function brokerStats(groups: DomainGroup[]): Array<{ value: string; count: number }> {
  const map = new Map<string, number>()
  for (const group of groups) {
    for (const entry of group.entries) {
      const broker = entry.trace.broker
      if (broker) map.set(broker, (map.get(broker) ?? 0) + 1)
    }
  }
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || collator.compare(a.value, b.value))
}

export const queueValues = (groups: DomainGroup[]) => distinct(groups, (trace) => trace.queue)
export const traceModeValues = (groups: DomainGroup[]) => distinct(groups, (trace) => trace.traceMode)

export function domainSummary(domains: DomainRecord[]) {
  return {
    domains: domains.length,
    traces: domains.reduce((n, d) => n + d.traces.length, 0),
    withBroker: domains.reduce((n, d) => n + d.traces.filter((t) => t.broker !== null).length, 0),
    withErrors: domains.filter((d) => d.errors.length > 0).length,
    routes: domains.reduce((n, d) => n + d.routes.length, 0),
    tracedRoutes: domains.reduce((n, d) => n + d.routes.filter((r) => r.traceEnabled).length, 0),
  }
}
