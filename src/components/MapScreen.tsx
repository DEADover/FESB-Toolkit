import { useCallback, useMemo, useState } from 'react'


import { useI18n } from '../i18n'
import { apiDomainStatistics } from '../lib/api'
import type { Connection, DomainStat, ServerInfo } from '../types'
import {
  AutoRefreshToggle, ErrorBar, NotConnected, Panel, RefreshButton, TableMessage, useApiData, useAutoRefresh,
} from './ApiShell'
import { Badge, Checkbox, cx, SearchInput } from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  /** Переход к СОПС домена: карта показывает, где болит, а лечат уже там. */
  onOpenRoutes: (guid: string) => void
  onGoToConnection: () => void
}

type SortKey = 'name' | 'routes' | 'running' | 'success' | 'errors' | 'inflight'

/**
 * Карта доменов: весь сервер на одном экране.
 *
 * При двух с половиной сотнях доменов вопрос «где сейчас болит» иначе никак
 * не задать — по умолчанию список отсортирован по ошибкам, а не по алфавиту.
 */
export function MapScreen({ connection, server, onOpenRoutes, onGoToConnection }: Props) {
  const { t } = useI18n()
  const load = useCallback((connection: Connection) => apiDomainStatistics(connection), [])
  const { data, loading, error, reload } = useApiData<DomainStat[]>(connection, load)

  const [query, setQuery] = useState('')
  const [onlyTrouble, setOnlyTrouble] = useState(false)
  const [sort, setSort] = useState<SortKey>('errors')
  const [auto, setAuto] = useState(false)

  useAutoRefresh(auto, reload)

  const stats = useMemo(() => data ?? [], [data])

  const totals = useMemo(() => stats.reduce((sum, item) => ({
    domains: sum.domains + 1,
    active: sum.active + (item.active ? 1 : 0),
    routes: sum.routes + item.routes,
    running: sum.running + item.running,
    success: sum.success + item.success,
    errors: sum.errors + item.errors,
    inflight: sum.inflight + item.inflight,
  }), { domains: 0, active: 0, routes: 0, running: 0, success: 0, errors: 0, inflight: 0 }), [stats])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const rows = stats.filter((item) => {
      // «Есть на что посмотреть» — ошибки, зависшие сообщения или незапущенные СОПС.
      if (onlyTrouble && item.errors === 0 && item.inflight === 0 && !(item.active && item.running < item.routes)) {
        return false
      }
      if (!needle) return true
      return item.name.toLowerCase().includes(needle) || item.guid.toLowerCase().includes(needle)
    })
    const by = (item: DomainStat) => {
      switch (sort) {
        case 'routes': return item.routes
        case 'running': return item.running
        case 'success': return item.success
        case 'errors': return item.errors
        case 'inflight': return item.inflight
        default: return 0
      }
    }
    return sort === 'name'
      ? [...rows].sort((a, b) => a.name.localeCompare(b.name))
      : [...rows].sort((a, b) => by(b) - by(a) || a.name.localeCompare(b.name))
  }, [stats, query, onlyTrouble, sort])

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-4">
      <div className="flex items-center gap-7 rounded-xl border border-line bg-surface px-5 py-3.5">
        <Total label={t('map.domains')} value={`${totals.active} / ${totals.domains}`} hint={t('map.domains.hint')} />
        <Total label={t('map.routes')} value={`${totals.running} / ${totals.routes}`} hint={t('map.routes.hint')} />
        <Total label={t('map.success')} value={totals.success.toLocaleString()} />
        <Total label={t('map.errors')} value={totals.errors.toLocaleString()} tone={totals.errors > 0 ? 'danger' : undefined} />
        <Total label={t('map.inflight')} value={totals.inflight.toLocaleString()} tone={totals.inflight > 0 ? 'warn' : undefined} />
        <div className="ml-auto flex items-center gap-2">
          <AutoRefreshToggle checked={auto} onChange={setAuto} />
          <RefreshButton
          busy={loading}
          disabled={loading}
          onClick={() => void reload()}
        />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <SearchInput
          className="flex-1"
          value={query}
          placeholder={t('map.search')}
          onChange={setQuery}
        />
        <label
          title={t('map.onlyTrouble.hint')}
          className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 text-[12.5px] text-content-muted"
        >
          <Checkbox checked={onlyTrouble} onChange={(event) => setOnlyTrouble(event.target.checked)} />
          {t('map.onlyTrouble')}
        </label>
        <span className="text-[11.5px] text-content-subtle">
          {t('map.shown', { visible: visible.length, total: stats.length })}
        </span>
      </div>

      <ErrorBar error={error} />

      <Panel className="flex-1">
        <table className="w-full table-fixed border-collapse text-[12.5px]">
          <colgroup>
            <col />
            <col className="w-24" />
            <col className="w-24" />
            <col className="w-28" />
            <col className="w-24" />
            <col className="w-24" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-surface-2 text-[11px] tracking-wide text-content-subtle">
            <tr className="border-b border-line">
              <Head label={t('table.domain')} id="name" sort={sort} onSort={setSort} align="left" />
              <Head label={t('map.routes')} id="routes" sort={sort} onSort={setSort} />
              <Head label={t('map.running')} id="running" sort={sort} onSort={setSort} />
              <Head label={t('map.success')} id="success" sort={sort} onSort={setSort} />
              <Head label={t('map.errors')} id="errors" sort={sort} onSort={setSort} />
              <Head label={t('map.inflight')} id="inflight" sort={sort} onSort={setSort} />
            </tr>
          </thead>
          <tbody>
            {visible.map((item) => (
              <tr
                key={item.guid}
                onClick={() => item.routes > 0 && onOpenRoutes(item.guid)}
                className={cx(
                  'border-b border-line/60 hover:bg-surface-2',
                  !item.active && 'text-content-subtle',
                  item.routes > 0 && 'cursor-pointer',
                )}
              >
                <td className="px-3 py-1.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={cx('size-1.5 shrink-0 rounded-full', item.active ? 'bg-positive' : 'bg-content-subtle/40')}
                      title={item.active ? t('table.active') : t('table.stopped')}
                    />
                    <span
                      className="min-w-0 flex-1 truncate font-medium"
                      title={item.routes > 0 ? t('map.openRoutes') : item.guid}
                    >
                      {item.name}
                    </span>
                    {item.active && item.running < item.routes && (
                      <Badge tone="warn" title={t('map.notAllRunning.hint')}>{t('map.notAllRunning')}</Badge>
                    )}
                  </div>
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{item.routes}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{item.running}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{item.success.toLocaleString()}</td>
                <td className={cx('px-3 py-1.5 text-right tabular-nums', item.errors > 0 && 'font-medium text-negative')}>
                  {item.errors.toLocaleString()}
                </td>
                <td className={cx('px-3 py-1.5 text-right tabular-nums', item.inflight > 0 && 'font-medium text-caution')}>
                  {item.inflight.toLocaleString()}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <TableMessage colSpan={6}>{loading ? t('empty.scanning') : t('table.empty')}</TableMessage>
            )}
          </tbody>
        </table>
      </Panel>
    </div>
  )
}

function Head({ label, id, sort, onSort, align }: {
  label: string
  id: SortKey
  sort: SortKey
  onSort: (key: SortKey) => void
  align?: 'left'
}) {
  return (
    <th className={cx('px-3 py-2 font-medium', align === 'left' ? 'text-left' : 'text-right')}>
      <button
        type="button"
        onClick={() => onSort(id)}
        className={cx('transition hover:text-content', sort === id && 'text-accent-content')}
      >
        {label}
      </button>
    </th>
  )
}

function Total({ label, value, hint, tone }: {
  label: string
  value: string
  hint?: string
  tone?: 'danger' | 'warn'
}) {
  return (
    <div title={hint}>
      <div className="text-[11px] tracking-wide text-content-subtle">{label}</div>
      <div className={cx(
        'text-[17px] font-semibold tabular-nums',
        tone === 'danger' && 'text-negative',
        tone === 'warn' && 'text-caution',
      )}>
        {value}
      </div>
    </div>
  )
}
