import type { DomainRecord, RouteInfo, ScanResult, TraceBean } from '../types'

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
/** `default` — трассировка включена, а объект не назван. */
export type RouteFilter = 'all' | 'untraced' | 'default'

export interface Filters {
  query: string
  broker: string | 'all' | 'none'
  onlyEditable: boolean
  /** Только записи, изменённые в текущей сессии. */
  onlyChanged: boolean
  /**
   * Каким СОПС домена интересуемся: любым, без трассировки или тем,
   * у которого трассировка включена, а объект не назван.
   */
  routes: RouteFilter
}

/**
 * Ключ отметки «изменено в этой сессии». Строится из пути файла и имени bean-а,
 * поэтому не зависит от порядка сканирования и переживает повторное чтение папки.
 */
export function changeKey(domain: DomainRecord, beanId: string | null): string {
  return `${domain.domainXmlPath}::${beanId ?? ''}`
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function matchesQuery(values: Array<string | null | undefined>, query: string): boolean {
  return values.some((value) => typeof value === 'string' && value.toLowerCase().includes(query))
}

/**
 * Назван ли у объекта трассировки менеджер очередей.
 *
 * Пустое свойство — то же самое, что его отсутствие: шина подставит
 * назначенный домену или серверу. Считать его за названный значит
 * обещать в сводке брокера, которого в таблице не увидишь.
 */
export function namedBroker(trace: TraceBean): string | null {
  const broker = trace.broker?.trim()
  return broker ? broker : null
}

/* --------------------------------- СОПС --------------------------------- */

/** Сколько СОПС в домене и в скольких из них включена трассировка. */
export function routeSummary(domain: DomainRecord) {
  const traced = domain.routes.filter((route) => route.traceEnabled).length
  return { total: domain.routes.length, traced, untraced: domain.routes.length - traced }
}

/**
 * СОПС, у которого трассировка включена, а объект не назван.
 *
 * Такой СОПС трассируется объектом домена по умолчанию. Найти их иначе нельзя:
 * в таблице они подписаны словами, а не именем объекта, и поиск по ним молчит.
 * На выгрузке из 255 доменов таких четыре — тем нужнее фильтр.
 */
export function tracedByDefault(route: RouteInfo): boolean {
  return route.traceEnabled && !route.inlineTraceConfig && route.traceConfigs.length === 0
}

/** Сколько СОПС домена подходит под выбранный фильтр. */
export function countRoutes(domain: DomainRecord, filter: Exclude<RouteFilter, 'all'>): number {
  return filter === 'untraced'
    ? domain.routes.filter((route) => !route.traceEnabled).length
    : domain.routes.filter(tracedByDefault).length
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
export function filterGroups(groups: DomainGroup[], filters: Filters, changedBeans: Set<string>): DomainGroup[] {
  const query = filters.query.trim().toLowerCase()
  const result: DomainGroup[] = []

  for (const group of groups) {
    if (filters.routes !== 'all' && countRoutes(group.domain, filters.routes) === 0) continue

    const domainMatches = !query || matchesQuery(
      [
        group.domain.domainName, group.domain.description, group.domain.guid, group.domain.dirName,
        ...group.domain.routes.flatMap((route) => [route.name, route.id, ...route.traceConfigs]),
      ],
      query,
    )

    if (group.entries.length === 0) {
      // Домен без объектов трассировки не подходит ни под какой отбор
      // по ним — включая «без брокера»: объекта нет, а не брокера.
      if (filters.broker === 'all' && !filters.onlyEditable && !filters.onlyChanged && domainMatches) {
        result.push(group)
      }
      continue
    }

    const entries = group.entries.filter((entry) => {
      const broker = namedBroker(entry.trace)
      if (filters.broker === 'none' && broker !== null) return false
      if (filters.broker !== 'all' && filters.broker !== 'none' && broker !== filters.broker) return false
      if (filters.onlyEditable && !entry.editable) return false
      if (filters.onlyChanged && !changedBeans.has(changeKey(group.domain, entry.trace.beanId))) return false
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
      case 'broker': return (group.entries[0] && namedBroker(group.entries[0].trace)) ?? '￿'
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
      const broker = namedBroker(entry.trace)
      if (broker) map.set(broker, (map.get(broker) ?? 0) + 1)
    }
  }
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || collator.compare(a.value, b.value))
}

/**
 * Сколько объектов трассировки не называют брокера.
 *
 * Отбор по ним в `filterGroups` был с самого начала, а кнопки к нему не было:
 * `brokerStats` такие объекты выбрасывал, и найти их было нечем.
 */
export function withoutBroker(groups: DomainGroup[]): number {
  return groups.reduce(
    (count, group) => count + group.entries.filter((entry) => namedBroker(entry.trace) === null).length,
    0,
  )
}

export const queueValues = (groups: DomainGroup[]) => distinct(groups, (trace) => trace.queue)
export const traceModeValues = (groups: DomainGroup[]) => distinct(groups, (trace) => trace.traceMode)

export function domainSummary(domains: DomainRecord[]) {
  return {
    domains: domains.length,
    traces: domains.reduce((n, d) => n + d.traces.length, 0),
    withBroker: domains.reduce((n, d) => n + d.traces.filter((t) => namedBroker(t) !== null).length, 0),
    withErrors: domains.filter((d) => d.errors.length > 0).length,
    routes: domains.reduce((n, d) => n + d.routes.length, 0),
    tracedRoutes: domains.reduce((n, d) => n + d.routes.filter((r) => r.traceEnabled).length, 0),
    defaultTraced: domains.reduce((n, d) => n + d.routes.filter(tracedByDefault).length, 0),
  }
}
