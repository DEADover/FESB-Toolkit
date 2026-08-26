import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useI18n } from '../i18n'
import { apiLog, apiLogFiles, errorText } from '../lib/api'
import type { Connection, LogEntry, LogFileRow, ServerInfo } from '../types'
import { ErrorBar, NotConnected, Panel, TableMessage, useApiData } from './ApiShell'
import { Badge, Button, Checkbox, ScrollStrip, Spinner, TextInput, cx } from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  onGoToConnection: () => void
}

const LEVELS = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'] as const
const REFRESH_MS = 10_000

/**
 * Журналы сервера прямо в приложении.
 *
 * Настоящая причина неудачного импорта видна только в `core.log`, и лазить
 * за ней в контейнер каждый раз — лишнее: сервер умеет отдавать записи
 * разобранными, с уровнем, потоком и классом.
 */
export function LogsScreen({ connection, server, onGoToConnection }: Props) {
  const { t } = useI18n()

  const loadFiles = useCallback((connection: Connection) => apiLogFiles(connection), [])
  const files = useApiData<LogFileRow[]>(connection, loadFiles)

  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set(['core.log']))
  const [levels, setLevels] = useState<Set<string>>(new Set(['ERROR', 'WARN']))
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(200)
  const [auto, setAuto] = useState(false)

  const [entries, setEntries] = useState<LogEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [copied, setCopied] = useState<number | null>(null)

  const toggle = useCallback((index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])

  /** Стектрейс чаще всего нужен не глазам, а тикету. */
  const copy = useCallback(async (text: string, index: number) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(index)
      setTimeout(() => setCopied((value) => (value === index ? null : value)), 1500)
    } catch {
      // Буфер может быть недоступен — молча остаёмся без копии.
    }
  }, [])

  // Автообновление не должно перезапускаться от каждой смены фильтра,
  // поэтому таймер дёргает всегда актуальную версию запроса.
  const latest = useRef<() => Promise<void>>(async () => {})

  const fetchEntries = useCallback(async () => {
    if (!connection) return
    setLoading(true)
    setError(null)
    try {
      const rows = await apiLog(connection, {
        logs: [...selectedFiles],
        levels: [...levels],
        search: search.trim() || null,
        limit,
      })
      setEntries(rows)
      setExpanded(new Set())
    } catch (err) {
      setError(errorText(err))
      setEntries(null)
    } finally {
      setLoading(false)
    }
  }, [connection, selectedFiles, levels, search, limit])

  latest.current = fetchEntries

  useEffect(() => { void fetchEntries() }, [fetchEntries])

  useEffect(() => {
    if (!auto) return
    const timer = setInterval(() => { void latest.current() }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [auto])

  const toggleFile = useCallback((name: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const toggleLevel = useCallback((level: string) => {
    setLevels((prev) => {
      const next = new Set(prev)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })
  }, [])

  const rows = entries ?? []
  const counts = useMemo(() => {
    const result = new Map<string, number>()
    for (const entry of rows) {
      const level = entry.level ?? '—'
      result.set(level, (result.get(level) ?? 0) + 1)
    }
    return result
  }, [rows])

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-4">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <TextInput
            value={search}
            placeholder={t('logs.search')}
            className="pl-8"
            onChange={(event) => setSearch(event.target.value)}
          />
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle">⌕</span>
        </div>
        <select
          value={limit}
          onChange={(event) => setLimit(Number(event.target.value))}
          className="h-9 rounded-lg border border-line-strong bg-surface px-2 text-[12.5px] text-content outline-none"
          aria-label={t('logs.limit')}
        >
          {[50, 200, 500, 1000].map((value) => (
            <option key={value} value={value}>{t('logs.lines', { count: value })}</option>
          ))}
        </select>
        <label className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 text-[12.5px] text-content-muted">
          <Checkbox checked={auto} onChange={(event) => setAuto(event.target.checked)} />
          {t('logs.auto')}
        </label>
        <Button onClick={() => void fetchEntries()} disabled={loading}>
          {loading ? <Spinner className="size-4" /> : '↻'} {t('action.refresh')}
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex shrink-0 items-center gap-1">
          {LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => toggleLevel(level)}
              className={cx(
                'rounded-lg border px-2 py-1 font-mono text-[11px] transition',
                levels.has(level)
                  ? levelTone(level)
                  : 'border-line-strong text-content-subtle hover:bg-surface-3',
              )}
            >
              {level}
              {counts.has(level) && <span className="ml-1.5 tabular-nums opacity-70">{counts.get(level)}</span>}
            </button>
          ))}
        </div>

        <ScrollStrip
          className="min-w-0 flex-1"
          itemCount={(files.data ?? []).length}
          scrollLeftLabel={t('action.scrollLeft')}
          scrollRightLabel={t('action.scrollRight')}
        >
          {(files.data ?? []).map((file) => (
            <button
              key={file.name}
              type="button"
              onClick={() => toggleFile(file.name)}
              title={t('logs.fileHint', { size: formatBytes(file.size) })}
              className={cx(
                'flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-[11.5px] transition',
                selectedFiles.has(file.name)
                  ? 'border-accent/50 bg-accent/12 text-accent-content'
                  : 'border-line-strong text-content-muted hover:bg-surface-3',
                file.size === 0 && 'opacity-50',
              )}
            >
              <span className="whitespace-nowrap font-mono">{file.name}</span>
              <span className="rounded bg-surface-3 px-1 text-[10px] tabular-nums">{formatBytes(file.size)}</span>
            </button>
          ))}
        </ScrollStrip>
      </div>

      <ErrorBar error={error ?? files.error} />

      <Panel className="flex-1">
        <table className="w-full table-fixed border-collapse text-[12.5px]">
          <colgroup>
            <col className="w-44" />
            <col className="w-16" />
            <col className="w-56" />
            <col />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-surface-2 text-[11px] tracking-wide text-content-subtle">
            <tr className="border-b border-line">
              <th className="px-3 py-2 text-left font-medium">{t('logs.time')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('logs.level')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('logs.source')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('logs.message')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry, index) => {
              const message = entry.message ?? ''
              const multiline = message.includes('\n')
              const open = expanded.has(index)
              return (
                <Fragment key={`${entry.timestamp ?? ''}-${index}`}>
                <tr
                  onClick={() => multiline && toggle(index)}
                  className={cx(
                    'align-top',
                    open ? 'bg-surface-2/60' : 'border-b border-line/60',
                    multiline && 'cursor-pointer hover:bg-surface-2',
                  )}
                >
                  <td className="px-3 py-1.5 font-mono text-[11px] text-content-subtle">
                    {formatTime(entry.timestamp)}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={cx('rounded px-1.5 py-0.5 font-mono text-[10.5px]', levelTone(entry.level ?? ''))}>
                      {entry.level ?? '—'}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="truncate font-mono text-[11px]" title={entry.className ?? ''}>
                      {entry.className ?? '—'}
                    </div>
                    <div className="truncate text-[10.5px] text-content-subtle" title={entry.thread ?? ''}>
                      {entry.file ?? ''}{entry.thread ? ` · ${entry.thread}` : ''}
                    </div>
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-start gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                        {message.split('\n')[0] || '—'}
                      </span>
                      {multiline && (
                        <Badge tone={open ? 'accent' : 'neutral'} title={t('logs.expandHint')}>
                          {open ? t('logs.collapse') : t('logs.expand')}
                        </Badge>
                      )}
                    </div>
                  </td>
                </tr>

                {/*
                  Стектрейс разворачивается отдельной строкой во всю ширину:
                  внутри колонки сообщений ему достаётся половина экрана,
                  и каждая строка трейса ломается по два-три раза.
                */}
                {open && (
                  <tr className="border-b border-line/60 bg-surface-2/60">
                    <td colSpan={4} className="px-3 pb-3">
                      <div className="flex items-start gap-2">
                        <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-content-muted">
                          {message}
                        </pre>
                        <Button size="sm" variant="ghost" onClick={(event) => { event.stopPropagation(); void copy(message, index) }}>
                          {copied === index ? t('logs.copied') : t('logs.copy')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              )
            })}
            {rows.length === 0 && (
              <TableMessage colSpan={4}>
                {loading
                  ? t('empty.scanning')
                  : selectedFiles.size === 0 ? t('logs.pickFile') : t('logs.empty')}
              </TableMessage>
            )}
          </tbody>
        </table>
      </Panel>
    </div>
  )
}

function levelTone(level: string): string {
  switch (level) {
    case 'ERROR': return 'border border-negative/40 bg-negative/12 text-negative'
    case 'WARN': return 'border border-caution/40 bg-caution/12 text-caution'
    case 'INFO': return 'border border-accent/40 bg-accent/12 text-accent-content'
    default: return 'border border-line-strong bg-surface-3 text-content-muted'
  }
}

/** `2026-08-26T18:11:26.012` → `26.08 18:11:26.012`. */
function formatTime(value: string | null): string {
  if (!value) return '—'
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(value)
  if (!match) return value
  return `${match[3]}.${match[2]} ${match[4].slice(0, 12)}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}
