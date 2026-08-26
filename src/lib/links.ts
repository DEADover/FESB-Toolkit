import type { LinkGraph, RouteNeighbour, RouteNeighbours } from '../types'

/**
 * `direct://Name?x=1` → `direct:Name`.
 *
 * Повторяет правило бэкенда: связи там считаются по нормализованному адресу,
 * и чтобы найти шаг схемы, ведущий к соседу, сравнивать надо так же.
 */
export function normalizeUri(uri: string): string | null {
  const head = uri.split('?')[0]?.trim()
  if (!head) return null
  const colon = head.indexOf(':')
  if (colon <= 0) return null
  const scheme = head.slice(0, colon).toLowerCase()
  return `${scheme}:${head.slice(colon + 1).replace(/^\/\//, '')}`
}

/** Соседи, разложенные по адресу: по нему шаг схемы находит свою связь. */
export function byUri(items: RouteNeighbour[]): Map<string, RouteNeighbour[]> {
  const map = new Map<string, RouteNeighbour[]>()
  for (const item of items) {
    const list = map.get(item.uri)
    if (list) list.push(item)
    else map.set(item.uri, [item])
  }
  return map
}

/**
 * Связи одной схемы: кто её вызывает и кого вызывает она.
 *
 * Граф приходит списком рёбер по всей выгрузке — здесь он сужается до одного
 * файла. В файле может лежать несколько маршрутов, поэтому берутся все его.
 */
export function neighboursOf(graph: LinkGraph | null, path: string | null): RouteNeighbours | null {
  if (!graph || !path) return null

  const mine = new Set<number>()
  graph.routes.forEach((route, index) => { if (route.path === path) mine.add(index) })
  if (mine.size === 0) return { incoming: [], outgoing: [] }

  const collect = (pick: (link: LinkGraph['links'][number]) => number, side: (link: LinkGraph['links'][number]) => number) => {
    const seen = new Set<string>()
    const result: RouteNeighbour[] = []
    for (const link of graph.links) {
      if (!mine.has(side(link))) continue
      const route = graph.routes[pick(link)]
      if (!route) continue
      // Один и тот же сосед может быть связан несколькими шагами — показываем раз.
      const key = `${route.path}|${link.uri}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ name: route.name, domain: route.domain, path: route.path, uri: link.uri, kind: link.kind })
    }
    return result.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
  }

  return {
    incoming: collect((link) => link.from, (link) => link.to),
    outgoing: collect((link) => link.to, (link) => link.from),
  }
}
