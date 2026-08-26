import type { LinkGraph, RouteNeighbour, RouteNeighbours } from '../types'

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
