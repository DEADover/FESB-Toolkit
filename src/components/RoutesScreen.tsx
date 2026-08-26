import { useCallback, useEffect, useMemo, useState } from 'react'

import { useI18n } from '../i18n'
import { apiDomainRoutes, apiDomainStatistics, apiRouteAction, apiRouteState, errorText } from '../lib/api'
import type {
  Connection, DomainRoutes, DomainStat, RouteAction, RouteFile, RouteState, ServerInfo,
} from '../types'
import { ErrorBar, NotConnected, Panel, TableMessage, useApiData } from './ApiShell'
import { RouteViewer } from './RouteViewer'
import { Badge, Button, Spinner, TextInput, cx } from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  isMac: boolean
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
export function RoutesScreen({ connection, server, isMac, onGoToConnection }: Props) {
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

  const withRoutes = useMemo(
    () => (stats.data ?? []).filter((item) => item.routes > 0),
    [stats.data],
  )
  const domains = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return withRoutes
    return withRoutes.filter((item) => item.name.toLowerCase().includes(needle))
  }, [withRoutes, query])

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
  useEffect(() => {
    if (selected || withRoutes.length === 0) return
    void openDomain(withRoutes[0])
  }, [selected, withRoutes, openDomain])

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  const routes = domain?.routes ?? []
  const openState = open?.id ? states[open.id] ?? null : null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-4">
      <ErrorBar error={stats.error ?? error} />

      <div className="flex min-h-0 flex-1 gap-3">
        <Panel className="flex w-72 shrink-0 flex-col">
          <div className="sticky top-0 z-10 border-b border-line bg-surface-2 px-2 py-2">
            <TextInput
              value={query}
              placeholder={t('routes.searchDomain')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="flex flex-col p-1.5">
            {domains.map((item) => (
              <button
                key={item.guid}
                type="button"
                onClick={() => void openDomain(item)}
                className={cx(
                  'flex items-center gap-2 rounded-lg px-2.5 py-2 text-left transition',
                  selected?.guid === item.guid ? 'bg-accent/12' : 'hover:bg-surface-3',
                )}
              >
                <span className={cx('size-1.5 shrink-0 rounded-full', item.active ? 'bg-positive' : 'bg-content-subtle/40')} />
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{item.name}</span>
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
            <Button
              className="ml-auto"
              onClick={() => selected && void openDomain(selected)}
              disabled={loading || !selected}
            >
              {loading ? <Spinner className="size-4" /> : '↻'} {t('action.refresh')}
            </Button>
          </div>

          <Panel className="flex-1">
            <table className="w-full table-fixed border-collapse text-[12.5px]">
              <colgroup>
                <col />
                <col className="w-28" />
                <col className="w-24" />
                <col className="w-20" />
                <col className="w-20" />
                {/* Три кнопки с русскими подписями шире, чем кажется. */}
                <col className="w-[272px]" />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-surface-2 text-[11px] tracking-wide text-content-subtle">
                <tr className="border-b border-line">
                  <th className="px-3 py-2 text-left font-medium">{t('table.route')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('table.state')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('routes.processed')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('map.errors')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('map.inflight')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('modules.actions')}</th>
                </tr>
              </thead>
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
                      <td className={cx('px-3 py-1.5 text-right tabular-nums', (state?.inflight ?? 0) > 0 && 'font-medium text-caution')}>
                        {state?.inflight ?? '—'}
                      </td>
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <RowButton
                            label={t('modules.start')}
                            busy={pending === `${route.id}:start`}
                            disabled={pending !== null || started}
                            onClick={() => void act(route, 'start')}
                          />
                          <RowButton
                            label={t('modules.stop')}
                            busy={pending === `${route.id}:stop`}
                            disabled={pending !== null || !started}
                            onClick={() => void act(route, 'stop')}
                          />
                          <RowButton
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
            </table>
          </Panel>
        </div>
      </div>

      <RouteViewer
        path={open?.path ?? null}
        domainName={domain?.name ?? null}
        isMac={isMac}
        live={openState}
        onClose={() => setOpen(null)}
      />
    </div>
  )
}

function RowButton({ label, busy, disabled, onClick }: {
  label: string
  busy: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Button size="sm" onClick={onClick} disabled={disabled || busy}>
      {busy ? <Spinner className="size-3.5" /> : label}
    </Button>
  )
}
