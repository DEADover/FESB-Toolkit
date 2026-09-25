// Указатель содержимого стенда для палитры команд.
//
// Палитра ищет не только экраны: набрал имя очереди, константы или СОПС —
// и видишь, где это лежит, и одним Enter попадаешь туда. Здесь только
// правила: из ответов API строится плоский список, а поиск по нему
// ранжирует совпадения. Сами запросы делает палитра.

import type { Focus } from './focus'
import type { QueueManager, QueueRow, RouteSummary, SweepRow, ApiDomain } from '../types'

export type IndexKind = 'domain' | 'route' | 'constant' | 'queue'

export type { Focus } from './focus'

export interface IndexEntry {
  kind: IndexKind
  /** То, что ищут и что видно крупно. */
  label: string
  /** Где это лежит: домен, уровень константы, менеджер. */
  where: string
  /** Дополнительный текст для поиска — значение константы. Не показывается. */
  extra?: string
  focus: Focus
}

export interface IndexSources {
  domains: ApiDomain[]
  routes: RouteSummary[]
  constants: SweepRow[]
  queues: Array<{ manager: QueueManager; queues: QueueRow[] }>
}

/** Уровень константы словами: у доменной — имя домена. */
function constantWhere(row: SweepRow, application: string, broker: string): string {
  if (row.scope === 'application') return application
  if (row.scope === 'broker') return broker
  return row.domain ?? row.scope
}

export function buildIndex(sources: IndexSources, labels: { application: string; broker: string }): IndexEntry[] {
  const entries: IndexEntry[] = []
  for (const domain of sources.domains) {
    entries.push({ kind: 'domain', label: domain.name, where: '', focus: { screen: 'api.routes', guid: domain.guid } })
  }
  for (const route of sources.routes) {
    entries.push({
      kind: 'route',
      label: route.name,
      where: route.domain,
      focus: { screen: 'api.routes', guid: route.domainGuid, route: route.id },
    })
  }
  for (const row of sources.constants) {
    entries.push({
      kind: 'constant',
      label: row.key,
      where: constantWhere(row, labels.application, labels.broker),
      // Секретное значение не ищем: шина отдаёт его замаскированным, и
      // совпадение по звёздочкам только сбивало бы с толку.
      extra: row.secured ? undefined : row.value ?? undefined,
      focus: { screen: 'api.properties', query: row.key },
    })
  }
  for (const { manager, queues } of sources.queues) {
    for (const queue of queues) {
      if (queue.internal) continue
      entries.push({
        kind: 'queue',
        label: queue.name,
        where: manager.broker,
        focus: { screen: 'api.queues', manager: { kind: manager.kind, id: manager.id }, query: queue.name },
      })
    }
  }
  return entries
}

/**
 * Совпадение по имени важнее совпадения по месту, начало имени — важнее
 * середины, точное имя — важнее всего. Значение константы — последним:
 * по нему ищут, когда не помнят ключ.
 */
function score(entry: IndexEntry, needle: string): number {
  const label = entry.label.toLowerCase()
  if (label === needle) return 0
  if (label.startsWith(needle)) return 1
  if (label.includes(needle)) return 2
  if (entry.where.toLowerCase().includes(needle)) return 3
  if (entry.extra?.toLowerCase().includes(needle)) return 4
  return -1
}

/** Меньше двух букв — не поиск: под одну букву подходит половина стенда. */
export const MIN_QUERY = 2

export function searchIndex(entries: IndexEntry[], query: string, perKind = 6): IndexEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle.length < MIN_QUERY) return []
  const ranked = entries
    .map((entry) => ({ entry, rank: score(entry, needle) }))
    .filter((row) => row.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.entry.label.length - b.entry.label.length || a.entry.label.localeCompare(b.entry.label))
  const taken = new Map<IndexKind, number>()
  const result: IndexEntry[] = []
  for (const { entry } of ranked) {
    const count = taken.get(entry.kind) ?? 0
    if (count >= perKind) continue
    taken.set(entry.kind, count + 1)
    result.push(entry)
  }
  return result
}
