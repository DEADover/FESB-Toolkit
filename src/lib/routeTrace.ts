import type { DomainTraceBeans, RouteSummary, RouteTraceChange } from '../types'

/**
 * Что будет с каждым отмеченным СОПС, если применить правку трассировки.
 *
 * Считается до отправки: окно показывает итог заранее, а СОПС, которым
 * ничего не грозит, на сервер вовсе не уходят — каждое сохранение
 * перезапускает работающий СОПС и обнуляет его счётчики.
 */
export type RoutePlan =
  | { row: RouteSummary; kind: 'change' }
  | { row: RouteSummary; kind: 'unchanged' }
  /** Назначаемого объекта нет в домене СОПС: такой домен не поднялся бы. */
  | { row: RouteSummary; kind: 'missing'; missing: string[] }

export function configNames(config: string): string[] {
  return config.split(',').map((name) => name.trim()).filter(Boolean)
}

export function planRouteTrace(
  rows: RouteSummary[],
  change: RouteTraceChange,
  beans: Map<string, Set<string>> | null,
): RoutePlan[] {
  const names = change.config === null ? null : configNames(change.config)
  return rows.map((row): RoutePlan => {
    if (names && names.length > 0 && beans) {
      const known = beans.get(row.domainGuid)
      const missing = names.filter((name) => !known?.has(name))
      if (missing.length > 0) return { row, kind: 'missing', missing }
    }
    const trace = change.enabled ?? row.trace
    const config = names === null ? row.traceBeans : names
    const same = trace === row.trace && config.join(',') === row.traceBeans.join(',')
    return { row, kind: same ? 'unchanged' : 'change' }
  })
}

export function beansByDomain(list: DomainTraceBeans[]): Map<string, Set<string>> {
  return new Map(list.map((item) => [item.guid, new Set(item.beans.map((bean) => bean.name))]))
}

/** Объекты, которые можно назначить: из всех затронутых доменов, со счётом «в скольких есть». */
export function beanChoices(list: DomainTraceBeans[]): Array<{ name: string; domains: number }> {
  const counts = new Map<string, number>()
  for (const domain of list) {
    for (const name of new Set(domain.beans.map((bean) => bean.name))) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, domains]) => ({ name, domains }))
    .sort((a, b) => b.domains - a.domains || a.name.localeCompare(b.name))
}
