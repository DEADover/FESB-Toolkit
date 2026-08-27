import { useCallback, useEffect, useMemo, useState } from 'react'

import { ArrowCounterClockwise, Play, Stop } from '@phosphor-icons/react'

import { useI18n } from '../i18n'
import {
  apiDomainRoutes, apiDomainStatistics, apiRouteAction, apiRouteIndex, apiRouteState, errorText,
  onApiProgress, routeLinks,
} from '../lib/api'
import { neighboursOf } from '../lib/links'
import type {
  ApiProgress, Connection, DomainRouteNames, DomainRoutes, DomainStat, LinkGraph, RouteAction,
  RouteFile, RouteState, ServerInfo,
} from '../types'
import {
  AutoRefreshToggle, ErrorBar, NotConnected, Panel, RefreshButton, ScreenBody, TableMessage, useApiData, useAutoRefresh,
} from './ApiShell'
import { RouteViewer } from './RouteViewer'
import { Badge, cx, DataTable, IconButton, SearchInput, Spinner, Th, THead } from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  isMac: boolean
  /** Домен, выбранный снаружи — например, кликом на карте. */
  initialGuid?: string | null
  onGoToConnection: () => void
}

/**
 * СОПС прямо с сервера: домен слева, его маршруты справа, схема — по клику.
 *
 * Списком через `/api/broker/routes` не обойтись: он отдаёт только запущенные
 * маршруты, а на остановленном домене это пустота. Поэтому состав берётся
 * из выгрузки одного домена (доли секунды), а состояние и счётчики —
 * по каждому маршруту отдельно; так виден и остановленный.
 */
export function RoutesScreen({ connection, server, isMac, initialGuid, onGoToConnection }: Props) {
  const { t } = useI18n()
  const load = useCallback((connection: Connection) => apiDomainStatistics(connection), [])
  const stats = useApiData<DomainStat[]>(connection, load)

  const [selected, setSelected] = useState<DomainStat | null>(null)
  const [domain, setDomain] = useState<DomainRoutes | null>(null)
  const [states, setStates] = useState<Record<string, RouteState>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<RouteFile | null>(null)
  const [auto, setAuto] = useState(false)
  /** Связи считаются по временной копии домена — значит, только внутри него. */
  const [graph, setGraph] = useState<LinkGraph | null>(null)
  /**
   * Имена СОПС по всем доменам.
   *
   * Лёгкого способа спросить их у шины нет, поэтому указатель строится
   * по явной команде: это чтение всех доменов, минуты полторы.
   */
  const [index, setIndex] = useState<DomainRouteNames[] | null>(null)
  const [indexing, setIndexing] = useState(false)
  const [progress, setProgress] = useState<ApiProgress | null>(null)

  const withRoutes = useMemo(
    () => (stats.data ?? []).filter((item) => item.routes > 0),
    [stats.data],
  )
  /** Какие СОПС домена подошли под запрос — их видно прямо в списке. */
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle || !index) return new Map<string, string[]>()
    const found = new Map<string, string[]>()
    for (const item of index) {
      const hits = item.routes.filter((route) => route.toLowerCase().includes(needle))
      if (hits.length > 0) found.set(item.guid, hits)
    }
    return found
  }, [index, query])

  const domains = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return withRoutes
    return withRoutes.filter(
      (item) => item.name.toLowerCase().includes(needle) || matches.has(item.guid),
    )
  }, [withRoutes, query, matches])

  useEffect(() => {
    const unlisten = onApiProgress(setProgress)
    return () => { unlisten.then((off) => off()) }
  }, [])

  const buildIndex = useCallback(async () => {
    if (!connection) return
    setIndexing(true)
    setError(null)
    setProgress(null)
    try {
      setIndex(await apiRouteIndex(connection))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setIndexing(false)
      setProgress(null)
    }
  }, [connection])

  /** Состояние читается по каждому маршруту: списком отдаются только запущенные. */
  const readStates = useCallback(async (guid: string, routes: RouteFile[]) => {
    if (!connection) return
    const entries = await Promise.all(routes.map(async (route) => {
      if (!route.id) return null
      try {
        return [route.id, await apiRouteState(connection, guid, route.id)] as const
      } catch {
        return null
      }
    }))
    setStates(Object.fromEntries(entries.filter((item): item is readonly [string, RouteState] => item !== null)))
  }, [connection])

  const openDomain = useCallback(async (item: DomainStat) => {
    if (!connection) return
    setSelected(item)
    setLoading(true)
    setError(null)
    setStates({})
    setDomain(null)
    try {
      const result = await apiDomainRoutes(connection, item.guid)
      setDomain(result)
      setGraph(null)
      routeLinks(result.root).then(setGraph).catch(() => setGraph(null))
      await readStates(item.guid, result.routes)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [connection, readStates])

  const act = useCallback(async (route: RouteFile, action: RouteAction) => {
    if (!connection || !selected || !route.id) return
    setPending(`${route.id}:${action}`)
    setError(null)
    try {
      await apiRouteAction(connection, selected.guid, route.id, action)
      const fresh = await apiRouteState(connection, selected.guid, route.id)
      setStates((prev) => ({ ...prev, [route.id!]: fresh }))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setPending(null)
    }
  }, [connection, selected])

  // Первый домен со схемами открывается сам — экран не должен встречать пустотой.
  // Если домен пришёл извне (клик на карте), открывается именно он.
  useEffect(() => {
    if (withRoutes.length === 0) return
    const wanted = initialGuid ? withRoutes.find((item) => item.guid === initialGuid) : null
    if (wanted) {
      if (selected?.guid !== wanted.guid) void openDomain(wanted)
      return
    }
    if (!selected) void openDomain(withRoutes[0])
  }, [selected, withRoutes, openDomain, initialGuid])

  /** Обновляем только состояния: состав СОПС меняется куда реже счётчиков. */
  useAutoRefresh(auto, () => {
    if (selected && domain) void readStates(selected.guid, domain.routes)
  })

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  const routes = domain?.routes ?? []
  const openState = open?.id ? states[open.id] ?? null : null

  return (
    <ScreenBody>
      <ErrorBar error={stats.error ?? error} />

      <div className="flex min-h-0 flex-1 gap-3">
        <Panel className="flex w-60 shrink-0 flex-col xl:w-72">
          <div className="sticky top-0 z-10 flex flex-col gap-1.5 border-b border-line bg-surface-2 px-2 py-2">
            <SearchInput
              value={query}
              placeholder={index ? t('routes.searchBoth') : t('routes.searchDomain')}
              onChange={setQuery}
            />
            {index ? (
              <span className="px-1 text-[10.5px] text-content-subtle">
                {t('routes.indexReady', { count: index.reduce((sum, item) => sum + item.routes.length, 0) })}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => void buildIndex()}
                disabled={indexing}
                title={t('routes.buildIndex.hint')}
                className="flex items-center gap-1.5 rounded px-1 py-0.5 text-left text-[10.5px] text-accent-content transition hover:bg-surface-3 disabled:text-content-subtle"
              >
                {indexing ? (
                  <>
                    <Spinner className="size-3" />
                    {t('routes.indexing', { current: progress?.current ?? 0, total: progress?.total ?? 0 })}
                  </>
                ) : t('routes.buildIndex')}
              </button>
            )}
          </div>
          <div className="flex flex-col p-1.5">
            {domains.map((item) => (
              <button
                key={item.guid}
                type="button"
                onClick={() => void openDomain(item)}
                className={cx(
                  'flex items-start gap-2 rounded-lg px-2.5 py-2 text-left transition',
                  selected?.guid === item.guid ? 'bg-accent/12' : 'hover:bg-surface-3',
                )}
              >
                <span className={cx('mt-1.5 size-1.5 shrink-0 rounded-full', item.active ? 'bg-positive' : 'bg-content-subtle/40')} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px]">{item.name}</span>
                  {matches.get(item.guid)?.slice(0, 2).map((route) => (
                    <span key={route} className="block truncate text-[10px] text-accent-content">{route}</span>
                  ))}
                  {(matches.get(item.guid)?.length ?? 0) > 2 && (
                    <span className="block text-[10px] text-content-subtle">
                      {t('routes.matchesMore', { count: (matches.get(item.guid)?.length ?? 0) - 2 })}
                    </span>
                  )}
                </span>
                <span className="shrink-0 rounded bg-surface-2 px-1 text-[10px] tabular-nums text-content-subtle">
                  {item.routes}
                </span>
              </button>
            ))}
            {domains.length === 0 && (
              <p className="px-2.5 py-6 text-center text-[11.5px] text-content-subtle">
                {stats.loading ? t('empty.scanning') : t('table.empty')}
              </p>
            )}
          </div>
        </Panel>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-center gap-3">
            <span className="min-w-0 truncate text-[13px] font-semibold">
              {domain?.name ?? selected?.name ?? '—'}
            </span>
            <span className="text-[11.5px] text-content-subtle">{t('routes.count', { count: routes.length })}</span>
            <div className="ml-auto flex items-center gap-2">
              <AutoRefreshToggle checked={auto} onChange={setAuto} />
              <RefreshButton
                busy={loading}
                disabled={loading || !selected}
                onClick={() => selected && void openDomain(selected)}
              />
            </div>
          </div>

          <Panel className="flex-1">
            <DataTable>
              <colgroup>
                <col />
                <col className="w-24" />
                <col className="w-20" />
                <col className="w-16" />
                <col className="hidden w-20 xl:table-column" />
                <col className="w-28" />
              </colgroup>
              <THead>
                  <Th>{t('table.route')}</Th>
                  <Th>{t('table.state')}</Th>
                  <Th align="right">{t('routes.processed')}</Th>
                  <Th align="right">{t('map.errors')}</Th>
                  <Th align="right" className="hidden whitespace-nowrap xl:table-cell">{t('map.inflight')}</Th>
                  <Th>{t('modules.actions')}</Th>
                </THead>
              <tbody>
                {routes.map((route, index) => {
                  const state = route.id ? states[route.id] : undefined
                  const started = state?.state === 'Started'
                  return (
                    <tr key={route.id ?? index} className="border-b border-line/60 hover:bg-surface-2">
                      <td className="px-3 py-1.5">
                        <button
                          type="button"
                          onClick={() => setOpen(route)}
                          title={t('route.openHint')}
                          className="block w-full truncate text-left transition hover:text-accent-content hover:underline"
                        >
                          {route.name ?? t('routes.unknownName')}
                        </button>
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-mono text-[10px] text-content-subtle">{route.id}</span>
                          {route.traceEnabled && <Badge tone="ok">{t('routes.trace.on')}</Badge>}
                        </div>
                      </td>
                      <td className="px-3 py-1.5">
                        <Badge tone={started ? 'ok' : state ? 'neutral' : 'neutral'}>
                          {state?.state ?? '—'}
                        </Badge>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{state?.processed ?? '—'}</td>
                      <td className={cx('px-3 py-1.5 text-right tabular-nums', (state?.failed ?? 0) > 0 && 'font-medium text-negative')}>
                        {state?.failed ?? '—'}
                      </td>
                      <td className={cx('hidden px-3 py-1.5 text-right tabular-nums xl:table-cell', (state?.inflight ?? 0) > 0 && 'font-medium text-caution')}>
                        {state?.inflight ?? '—'}
                      </td>
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-1">
                          <IconButton
                            icon={Play}
                            label={t('modules.start')}
                            busy={pending === `${route.id}:start`}
                            disabled={pending !== null || started}
                            onClick={() => void act(route, 'start')}
                          />
                          <IconButton
                            icon={Stop}
                            label={t('modules.stop')}
                            busy={pending === `${route.id}:stop`}
                            disabled={pending !== null || !started}
                            onClick={() => void act(route, 'stop')}
                          />
                          <IconButton
                            icon={ArrowCounterClockwise}
                            label={t('routes.reset')}
                            busy={pending === `${route.id}:reset`}
                            disabled={pending !== null || !state}
                            onClick={() => void act(route, 'reset')}
                          />
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {routes.length === 0 && (
                  <TableMessage colSpan={6}>{loading ? t('empty.scanning') : t('routes.pickDomain')}</TableMessage>
                )}
              </tbody>
            </DataTable>
          </Panel>
        </div>
      </div>

      <RouteViewer
        path={open?.path ?? null}
        domainName={domain?.name ?? null}
        isMac={isMac}
        live={openState}
        links={neighboursOf(graph, open?.path ?? null)}
        onOpenRoute={(path) => {
          const target = domain?.routes.find((item) => item.path === path)
          if (target) setOpen(target)
        }}
        onClose={() => setOpen(null)}
      />
    </ScreenBody>
  )
}

