import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'

import { useI18n } from '../i18n'
import { errorText, routeLinks } from '../lib/api'
import type { LinkGraph, ScanResult } from '../types'
import { RouteViewer } from './RouteViewer'
import { Badge, Button, Checkbox, Spinner, TextInput, cx } from './ui'

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
      <div className="flex flex-1 items-center justify-center px-6 pb-10">
        <div className="max-w-md text-center">
          <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-surface-2 text-[22px] text-accent-content">⇄</div>
          <h2 className="mt-4 text-[15px] font-semibold">{t('domainLinks.noScan')}</h2>
          <p className="mt-2 text-content-subtle">{t('domainLinks.noScan.text')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-4">
      <div className="flex items-center gap-7 rounded-xl border border-line bg-surface px-5 py-3.5">
        <Total label={t('domainLinks.total')} value={totals.links} />
        <Total label={t('domainLinks.cross')} value={totals.crossLinks} tone="accent" />
        <Total label={t('domainLinks.pairs')} value={totals.pairs} />
        <Total label={t('domainLinks.domains')} value={totals.domains} />
        <Button className="ml-auto" onClick={() => void load()} disabled={loading}>
          {loading ? <Spinner className="size-4" /> : '↻'} {t('action.refresh')}
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <TextInput
            value={query}
            placeholder={t('domainLinks.search')}
            className="pl-8"
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle">⌕</span>
        </div>
        <label
          title={t('domainLinks.onlyCross.hint')}
          className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 text-[12.5px] text-content-muted"
        >
          <Checkbox checked={onlyCross} onChange={(event) => setOnlyCross(event.target.checked)} />
          {t('domainLinks.onlyCross')}
        </label>
        <span className="text-[11.5px] text-content-subtle">
          {t('map.shown', { visible: visible.length, total: pairs.length })}
        </span>
      </div>

      {error && <div className="rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-negative">{error}</div>}

      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-surface">
        <table className="w-full table-fixed border-collapse text-[12.5px]">
          <colgroup>
            <col />
            <col className="w-8" />
            <col />
            <col className="w-28" />
            <col className="w-28" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-surface-2 text-[11px] tracking-wide text-content-subtle">
            <tr className="border-b border-line">
              <th className="px-3 py-2 text-left font-medium">{t('domainLinks.from')}</th>
              <th className="px-1 py-2" />
              <th className="px-3 py-2 text-left font-medium">{t('domainLinks.to')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('links.call')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('links.queue')}</th>
            </tr>
          </thead>
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
                    <td className="px-1 py-1.5 text-center text-content-subtle">→</td>
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
                              <span className="shrink-0 text-content-subtle">→</span>
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
        </table>
      </div>

      <RouteViewer
        path={route?.path ?? null}
        domainName={route?.domain ?? null}
        isMac={isMac}
        live={null}
        onClose={() => setRoute(null)}
      />
    </div>
  )
}

function Total({ label, value, tone }: { label: string; value: number; tone?: 'accent' }) {
  return (
    <div>
      <div className="text-[11px] tracking-wide text-content-subtle">{label}</div>
      <div className={cx('text-[17px] font-semibold tabular-nums', tone === 'accent' && 'text-accent-content')}>
        {value.toLocaleString()}
      </div>
    </div>
  )
}
