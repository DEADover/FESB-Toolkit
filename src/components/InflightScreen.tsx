import { useCallback, useMemo, useState } from 'react'

import { CheckCircle } from '@phosphor-icons/react'

import { useI18n, type MessageKey } from '../i18n'
import { apiInflight } from '../lib/api'
import type { Connection, InflightExchange, ServerInfo } from '../types'
import {
  AutoRefreshToggle, ErrorBar, NotConnected, Panel, RefreshButton, ScreenBody, StatsBar, TableMessage,
  useApiData, useAutoRefresh, useDebounced,
} from './ApiShell'
import {
  Badge, cx, DataTable, EmptyState, Readout, SearchInput, Select, Th, THead, Toggle,
} from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  onGoToConnection: () => void
  onOpenRoutes: (domainGuid: string) => void
}

/**
 * Сколько обмен должен идти, чтобы на него стоило посмотреть.
 *
 * Минута выбрана не по красоте: обычный обмен на шине укладывается
 * в сотни миллисекунд, и всё, что живёт дольше минуты, либо ждёт чужую
 * систему, либо уже никого не дождётся.
 */
const SLOW_MS = 60_000

/** Вид домена, из которого пришёл обмен. */
type Kind = 'all' | 'broker' | 'rest' | 'ws'

const KIND_LABEL: Record<Exclude<Kind, 'all'>, MessageKey> = {
  broker: 'inflight.kind.broker',
  rest: 'inflight.kind.rest',
  ws: 'inflight.kind.ws',
}

/** `184000` → `3 мин 4 с`: миллисекунды в таблице не читаются. */
function duration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms} ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * Обмены, которые шина ещё не довела до конца.
 *
 * Счётчик «в работе» есть и у домена, и у СОПС, но он отвечает только
 * «сколько». Спрашивают обычно другое: что именно висит, в каком СОПС
 * и на каком шаге. Ответ живёт ровно то время, что висит сам обмен,
 * поэтому у экрана есть автообновление.
 */
export function InflightScreen({ connection, server, onGoToConnection, onOpenRoutes }: Props) {
  const { t } = useI18n()
  const load = useCallback((open: Connection) => apiInflight(open), [])
  const { data, loading, error, reload } = useApiData<InflightExchange[]>(connection, load)

  const [search, setSearch] = useState('')
  const [onlySlow, setOnlySlow] = useState(false)
  const [kind, setKind] = useState<Kind>('all')
  const [auto, setAuto] = useState(false)
  const query = useDebounced(search, 250)

  useAutoRefresh(auto, reload)

  const all = useMemo(() => data ?? [], [data])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return all.filter((row) => {
      if (onlySlow && (row.duration ?? 0) < SLOW_MS) return false
      if (kind !== 'all' && row.kind !== kind) return false
      if (!needle) return true
      return (
        row.domain.toLowerCase().includes(needle) ||
        row.route.toLowerCase().includes(needle) ||
        (row.at ?? '').toLowerCase().includes(needle) ||
        (row.node ?? '').toLowerCase().includes(needle) ||
        (row.detail ?? '').toLowerCase().includes(needle) ||
        row.id.toLowerCase().includes(needle)
      )
    })
  }, [all, query, onlySlow, kind])

  const totals = useMemo(() => ({
    total: all.length,
    slow: all.filter((row) => (row.duration ?? 0) >= SLOW_MS).length,
    interrupted: all.filter((row) => row.interrupted).length,
    domains: new Set(all.map((row) => row.domain).filter(Boolean)).size,
  }), [all])

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  // Пустой список — не «нет данных», а хорошая новость, и выглядеть
  // он должен соответственно.
  if (data !== null && all.length === 0) {
    return (
      <ScreenBody>
        <ErrorBar error={error} />
        <EmptyState icon={CheckCircle} title={t('inflight.empty')} text={t('inflight.empty.text')}>
          <div className="mt-4 flex items-center gap-2">
            <AutoRefreshToggle checked={auto} onChange={setAuto} />
            <RefreshButton className="min-w-32" busy={loading} onClick={() => void reload()} />
          </div>
        </EmptyState>
      </ScreenBody>
    )
  }

  return (
    <ScreenBody>
      <StatsBar>
        <Readout label={t('inflight.total')} value={totals.total.toLocaleString()} tone="accent" />
        <Readout
          label={t('inflight.slow')}
          value={totals.slow.toLocaleString()}
          tone={totals.slow > 0 ? 'warn' : undefined}
          hint={t('inflight.slow.hint')}
        />
        <Readout
          label={t('inflight.interrupted')}
          value={totals.interrupted.toLocaleString()}
          tone={totals.interrupted > 0 ? 'danger' : undefined}
        />
        <Readout label={t('inflight.domains')} value={totals.domains.toLocaleString()} />
        <div className="ml-auto flex items-center gap-2">
          <AutoRefreshToggle checked={auto} onChange={setAuto} />
          <RefreshButton className="min-w-32" busy={loading} onClick={() => void reload()} />
        </div>
      </StatsBar>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          className="min-w-64 flex-1"
          value={search}
          placeholder={t('inflight.search')}
          onChange={setSearch}
          clearLabel={t('action.clearSearch')}
        />
        <Toggle
          checked={onlySlow}
          onChange={setOnlySlow}
          label={t('inflight.onlySlow')}
          title={t('inflight.slow.hint')}
        />
        <Select<Kind>
          ariaLabel={t('inflight.kind')}
          label={t('inflight.kind')}
          className="w-52"
          value={kind}
          onChange={setKind}
          options={[
            { id: 'all', label: t('filter.all') },
            { id: 'broker', label: t('inflight.kind.broker') },
            { id: 'rest', label: t('inflight.kind.rest') },
            { id: 'ws', label: t('inflight.kind.ws') },
          ]}
        />
      </div>

      <ErrorBar error={error} />

      <Panel className="flex-1">
        <DataTable>
          <colgroup>
            <col className="w-44" />
            <col />
            <col className="w-48" />
            <col className="w-48" />
            <col className="hidden w-44 xl:table-column" />
            <col className="w-24" />
            <col className="w-24" />
          </colgroup>
          <THead>
            <Th>{t('table.domain')}</Th>
            <Th>{t('table.route')}</Th>
            <Th>{t('inflight.at')}</Th>
            <Th>{t('inflight.node')}</Th>
            <Th className="hidden xl:table-cell">{t('inflight.thread')}</Th>
            <Th align="right">{t('inflight.duration')}</Th>
            <Th align="right">{t('inflight.elapsed')}</Th>
          </THead>
          <tbody>
            {visible.map((row) => {
              const slow = (row.duration ?? 0) >= SLOW_MS
              return (
                <tr
                  key={row.id || `${row.routeId}-${row.thread}`}
                  onClick={() => row.domainGuid && onOpenRoutes(row.domainGuid)}
                  title={row.id}
                  className={cx(
                    'border-b border-line/60 align-top',
                    row.domainGuid ? 'cursor-pointer hover:bg-surface-2' : undefined,
                  )}
                >
                  <td className="truncate px-3 py-1.5">
                    <span className="flex items-center gap-1.5">
                      <span className="min-w-0 truncate">{row.domain || '—'}</span>
                      {row.kind !== 'broker' && <Badge>{t(KIND_LABEL[row.kind])}</Badge>}
                    </span>
                  </td>
                  <td className="px-3 py-1.5" title={t('map.openRoutes')}>
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 truncate">{row.route || '—'}</span>
                      {row.interrupted && <Badge tone="danger">{t('inflight.interrupted.one')}</Badge>}
                    </div>
                    {/* Идентификатор обмена нужен, чтобы найти его же в журналах. */}
                    <div className="truncate font-mono text-[10.5px] text-content-subtle">{row.id}</div>
                  </td>
                  <td className="truncate px-3 py-1.5 text-content-muted" title={row.detail ?? row.at ?? undefined}>
                    {/* У REST и веб-сервисов «сейчас в» пусто, зато есть вызов:
                        `POST /users/42` говорит о застрявшем обмене больше. */}
                    {row.at ?? row.detail ?? '—'}
                  </td>
                  <td className="truncate px-3 py-1.5">{row.node ?? '—'}</td>
                  <td className="hidden truncate px-3 py-1.5 font-mono text-[11px] text-content-subtle xl:table-cell">
                    {row.thread ?? '—'}
                  </td>
                  <td className={cx('px-3 py-1.5 text-right tabular-nums', slow && 'font-medium text-caution')}>
                    {duration(row.duration)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-content-muted">
                    {duration(row.elapsed)}
                  </td>
                </tr>
              )
            })}
            {visible.length === 0 && (
              <TableMessage colSpan={7}>{loading ? t('empty.scanning') : t('inflight.nothing')}</TableMessage>
            )}
          </tbody>
        </DataTable>
      </Panel>
    </ScreenBody>
  )
}
