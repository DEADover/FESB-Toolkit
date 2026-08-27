import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'


import { useI18n } from '../i18n'
import { apiAudit, errorText } from '../lib/api'
import type { AuditEntry, Connection, ServerInfo } from '../types'
import {
  AutoRefreshToggle, ErrorBar, FilterChip, LimitSelect, NotConnected, Panel, RefreshButton, TableMessage, useAutoRefresh,
} from './ApiShell'
import { Badge, CodePill, cx, SearchInput } from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  onGoToConnection: () => void
}

type Filter = 'all' | 'action' | 'login' | 'session'

/**
 * Аудит: кто и что делал на стенде.
 *
 * Инструмент массово правит чужую конфигурацию, и вопрос «кто это изменил»
 * рано или поздно задают. Шина пишет ответ в `audit.log`, но текстом —
 * здесь он разобран на пользователя, адрес, действие и код ответа,
 * а собственные выгрузки и заливки приложения видны наравне с остальными.
 */
export function AuditScreen({ connection, server, onGoToConnection }: Props) {
  const { t } = useI18n()
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(200)
  const [filter, setFilter] = useState<Filter>('action')
  const [auto, setAuto] = useState(false)
  const [open, setOpen] = useState<number | null>(null)

  const load = useCallback(async () => {
    if (!connection) return
    setLoading(true)
    setError(null)
    try {
      setEntries(await apiAudit(connection, {
        logs: [],
        levels: [],
        search: search.trim() || null,
        limit,
      }))
      setOpen(null)
    } catch (err) {
      setError(errorText(err))
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [connection, search, limit])

  useEffect(() => { void load() }, [load])
  useAutoRefresh(auto, load)

  const visible = useMemo(
    () => (filter === 'all' ? entries : entries.filter((entry) => entry.kind === filter)),
    [entries, filter],
  )

  const counts = useMemo(() => {
    const result = { action: 0, login: 0, session: 0, failed: 0 }
    for (const entry of entries) {
      if (entry.kind === 'action') result.action++
      if (entry.kind === 'login') result.login++
      if (entry.kind === 'session') result.session++
      if (isFailure(entry)) result.failed++
    }
    return result
  }, [entries])

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-4">
      <div className="flex items-center gap-2">
        <SearchInput
          className="flex-1"
          value={search}
          placeholder={t('audit.search')}
          onChange={setSearch}
        />
        <LimitSelect value={limit} onChange={setLimit} />
        <AutoRefreshToggle checked={auto} onChange={setAuto} />
        <RefreshButton
          busy={loading}
          disabled={loading}
          onClick={() => void load()}
        />
      </div>

      <div className="flex items-center gap-1">
        <FilterChip active={filter === 'action'} onClick={() => setFilter('action')} count={counts.action}>
          {t('audit.filter.action')}
        </FilterChip>
        <FilterChip active={filter === 'login'} onClick={() => setFilter('login')} count={counts.login}>
          {t('audit.filter.login')}
        </FilterChip>
        <FilterChip active={filter === 'session'} onClick={() => setFilter('session')} count={counts.session}>
          {t('audit.filter.session')}
        </FilterChip>
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} count={entries.length}>
          {t('filter.all')}
        </FilterChip>
        {counts.failed > 0 && (
          <Badge tone="danger" className="ml-2" title={t('audit.failed.hint')}>
            {t('audit.failed', { count: counts.failed })}
          </Badge>
        )}
      </div>

      <ErrorBar error={error} />

      <Panel className="flex-1">
        <table className="w-full table-fixed border-collapse text-[12.5px]">
          <colgroup>
            <col className="w-44" />
            <col className="w-32" />
            <col className="w-32" />
            <col />
            <col className="w-20" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-surface-2 text-[11px] tracking-wide text-content-subtle">
            <tr className="border-b border-line">
              <th className="px-3 py-2 text-left font-medium">{t('logs.time')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('api.info.user')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('audit.ip')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('audit.action')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('audit.result')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((entry, index) => {
              const shown = open === index
              const failed = isFailure(entry)
              return (
                <Fragment key={`${entry.timestamp ?? ''}-${index}`}>
                  <tr
                    onClick={() => setOpen(shown ? null : index)}
                    className={cx(
                      'cursor-pointer align-top',
                      shown ? 'bg-surface-2/60' : 'border-b border-line/60 hover:bg-surface-2',
                    )}
                  >
                    <td className="px-3 py-1.5 font-mono text-[11px] text-content-subtle">
                      {formatTime(entry.timestamp)}
                    </td>
                    <td className="truncate px-3 py-1.5">{entry.user ?? '—'}</td>
                    <td className="truncate px-3 py-1.5 font-mono text-[11px] text-content-subtle">
                      {entry.ip ?? '—'}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className={cx('truncate font-mono text-[11.5px]', failed && 'text-negative')}>
                        {entry.action ?? '—'}
                      </span>
                      {entry.arguments && (
                        <div className="truncate font-mono text-[10px] text-content-subtle">{entry.arguments}</div>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {entry.status !== null ? (
                        <CodePill tone={entry.status >= 400 ? 'danger' : 'ok'}>{entry.status}</CodePill>
                      ) : (
                        <span className="text-[11px] text-content-subtle">—</span>
                      )}
                    </td>
                  </tr>

                  {shown && (
                    <tr className="border-b border-line/60 bg-surface-2/60">
                      <td colSpan={5} className="px-3 pb-3">
                        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-content-muted">
                          {entry.text}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {visible.length === 0 && (
              <TableMessage colSpan={5}>{loading ? t('empty.scanning') : t('audit.empty')}</TableMessage>
            )}
          </tbody>
        </table>
      </Panel>
    </div>
  )
}

/** Неудачный вход или ответ с ошибкой — то, что ищут в аудите первым делом. */
function isFailure(entry: AuditEntry): boolean {
  if (entry.status !== null && entry.status >= 400) return true
  return (entry.action ?? '').toLowerCase().includes('failed')
}

/** `2026-08-27T00:06:10.488` → `27.08 00:06:10`. */
function formatTime(value: string | null): string {
  if (!value) return '—'
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(value)
  return match ? `${match[3]}.${match[2]} ${match[4]}` : value
}

