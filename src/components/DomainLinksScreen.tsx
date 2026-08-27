import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'

import { ArrowRight, ArrowsLeftRight } from '@phosphor-icons/react'

import { useI18n } from '../i18n'
import { errorText, routeLinks } from '../lib/api'
import type { LinkGraph, ScanResult } from '../types'
import { RouteViewer } from './RouteViewer'
import {
  RefreshButton, ScreenBody,
} from './ApiShell'
import { Badge, cx, DataTable, EmptyState, Notice, Readout, SearchInput, Th, THead, Toggle } from './ui'

interface Props {
  scan: ScanResult | null
  isMac: boolean
}

/** Одна связь между парой доменов: какой маршрут кого зовёт и каким адресом. */
interface PairLink {
  fromRoute: string
  fromPath: string
  toRoute: string
  toPath: string
  uri: string
  kind: string
}

interface DomainPair {
  key: string
  from: string
  to: string
  internal: boolean
  calls: number
  queues: number
  links: PairLink[]
}

/**
 * Связи между доменами: кто с кем разговаривает.
 *
 * Тот же граф, что и у отдельной схемы, но собранный по доменам. На двух
 * с половиной сотнях доменов это единственный способ увидеть, что домен,
 * который считали независимым, на самом деле кормит половину шины.
 */
export function DomainLinksScreen({ scan, isMac }: Props) {
  const { t } = useI18n()
  const [graph, setGraph] = useState<LinkGraph | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [onlyCross, setOnlyCross] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [route, setRoute] = useState<{ path: string; domain: string } | null>(null)

  const root = scan?.root ?? null

  const load = useCallback(async () => {
    if (!root) return
    setLoading(true)
    setError(null)
    try {
      setGraph(await routeLinks(root))
    } catch (err) {
      setError(errorText(err))
      setGraph(null)
    } finally {
      setLoading(false)
    }
  }, [root])

  useEffect(() => { void load() }, [load])

  const pairs = useMemo(() => {
    if (!graph) return []
    const map = new Map<string, DomainPair>()
    for (const link of graph.links) {
      const from = graph.routes[link.from]
      const to = graph.routes[link.to]
      if (!from || !to) continue
      const key = `${from.domainDir}→${to.domainDir}`
      let pair = map.get(key)
      if (!pair) {
        pair = {
          key,
          from: from.domain,
          to: to.domain,
          internal: from.domainDir === to.domainDir,
          calls: 0,
          queues: 0,
          links: [],
        }
        map.set(key, pair)
      }
      if (link.kind === 'call') pair.calls++
      else pair.queues++
      pair.links.push({
        fromRoute: from.name ?? t('routes.unknownName'),
        fromPath: from.path,
        toRoute: to.name ?? t('routes.unknownName'),
        toPath: to.path,
        uri: link.uri,
        kind: link.kind,
      })
    }
    return [...map.values()].sort((a, b) => b.links.length - a.links.length || a.from.localeCompare(b.from))
  }, [graph, t])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return pairs.filter((pair) => {
      if (onlyCross && pair.internal) return false
      if (!needle) return true
      return pair.from.toLowerCase().includes(needle) || pair.to.toLowerCase().includes(needle)
    })
  }, [pairs, query, onlyCross])

  const totals = useMemo(() => {
    const cross = pairs.filter((pair) => !pair.internal)
    const domains = new Set<string>()
    for (const pair of cross) { domains.add(pair.from); domains.add(pair.to) }
    return {
      links: pairs.reduce((sum, pair) => sum + pair.links.length, 0),
      crossLinks: cross.reduce((sum, pair) => sum + pair.links.length, 0),
      pairs: cross.length,
      domains: domains.size,
    }
  }, [pairs])

  if (!scan) {
    return (
      <EmptyState
        icon={ArrowsLeftRight}
        title={t('domainLinks.noScan')}
        text={t('domainLinks.noScan.text')}
      />
    )
  }

  return (
    <ScreenBody>
      <div className="flex items-center gap-7 rounded-xl border border-line bg-surface px-5 py-3.5">
        <Readout label={t('domainLinks.total')} value={totals.links.toLocaleString()} />
        <Readout label={t('domainLinks.cross')} value={totals.crossLinks.toLocaleString()} tone="accent" />
        <Readout label={t('domainLinks.pairs')} value={totals.pairs.toLocaleString()} />
        <Readout label={t('domainLinks.domains')} value={totals.domains.toLocaleString()} />
        <RefreshButton className="ml-auto"
          busy={loading}
          disabled={loading}
          onClick={() => void load()}
        />
      </div>

      <div className="flex items-center gap-2">
        <SearchInput
          className="flex-1"
          value={query}
          placeholder={t('domainLinks.search')}
          onChange={setQuery}
        />
        <Toggle
          checked={onlyCross}
          onChange={setOnlyCross}
          label={t('domainLinks.onlyCross')}
          title={t('domainLinks.onlyCross.hint')}
        />
        <span className="text-[11.5px] text-content-subtle">
          {t('map.shown', { visible: visible.length, total: pairs.length })}
        </span>
      </div>

      {error && <Notice tone="danger">{error}</Notice>}

      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-surface">
        <DataTable>
          <colgroup>
            <col />
            <col className="w-8" />
            <col />
            <col className="w-28" />
            <col className="w-28" />
          </colgroup>
          <THead>
              <Th>{t('domainLinks.from')}</Th>
              <Th className="px-1" />
              <Th>{t('domainLinks.to')}</Th>
              <Th align="right">{t('links.call')}</Th>
              <Th align="right">{t('links.queue')}</Th>
            </THead>
          <tbody>
            {visible.map((pair) => {
              const open = expanded === pair.key
              return (
                <Fragment key={pair.key}>
                  <tr
                    onClick={() => setExpanded(open ? null : pair.key)}
                    className={cx(
                      'cursor-pointer align-top',
                      open ? 'bg-surface-2/60' : 'border-b border-line/60 hover:bg-surface-2',
                    )}
                  >
                    <td className="truncate px-3 py-1.5 font-medium" title={pair.from}>{pair.from}</td>
                    <td className="px-1 py-1.5 text-center text-content-subtle"><ArrowRight size={12} weight="bold" className="inline" /></td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-medium" title={pair.to}>{pair.to}</span>
                        {pair.internal && <Badge>{t('domainLinks.internal')}</Badge>}
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{pair.calls || '—'}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{pair.queues || '—'}</td>
                  </tr>

                  {open && (
                    <tr className="border-b border-line/60 bg-surface-2/60">
                      <td colSpan={5} className="px-3 pb-3">
                        <div className="flex flex-col gap-1">
                          {pair.links.map((link, index) => (
                            <div
                              key={`${link.fromPath}-${link.toPath}-${link.uri}-${index}`}
                              className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5"
                            >
                              <button
                                type="button"
                                onClick={() => setRoute({ path: link.fromPath, domain: pair.from })}
                                className="min-w-0 flex-1 truncate text-left text-[12px] transition hover:text-accent-content hover:underline"
                              >
                                {link.fromRoute}
                              </button>
                              <span className="shrink-0 font-mono text-[10.5px] text-content-subtle">{link.uri}</span>
                              <ArrowRight size={12} weight="bold" className="shrink-0 text-content-subtle" />
                              <button
                                type="button"
                                onClick={() => setRoute({ path: link.toPath, domain: pair.to })}
                                className="min-w-0 flex-1 truncate text-left text-[12px] transition hover:text-accent-content hover:underline"
                              >
                                {link.toRoute}
                              </button>
                              <span className={cx(
                                'shrink-0 rounded px-1 text-[9.5px]',
                                link.kind === 'call' ? 'bg-accent/15 text-accent-content' : 'bg-surface-3 text-content-subtle',
                              )}>
                                {link.kind === 'call' ? t('links.call') : t('links.queue')}
                              </span>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-10 text-center text-content-subtle">
                  {loading ? t('empty.scanning') : t('domainLinks.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </DataTable>
      </div>

      <RouteViewer
        path={route?.path ?? null}
        domainName={route?.domain ?? null}
        isMac={isMac}
        live={null}
        onClose={() => setRoute(null)}
      />
    </ScreenBody>
  )
}

