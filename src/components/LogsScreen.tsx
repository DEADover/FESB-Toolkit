import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'

import { useI18n } from '../i18n'
import { apiLog, apiLogFiles, errorText } from '../lib/api'
import { formatBytes } from '../lib/format'
import type { Connection, LogEntry, LogFileRow, ServerInfo } from '../types'
import {
  AutoRefreshToggle, ErrorBar, LimitSelect, useDebounced, NotConnected, Panel, RefreshButton, ScreenBody, TableMessage, useApiData, useAutoRefresh,
} from './ApiShell'
import { Badge, Button, CodePill, cx, DataTable, MultiSelect, rowClick, SearchInput, Th, THead, type Tone } from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  onGoToConnection: () => void
}

const LEVELS = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'] as const

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

  // Поиск уходит на сервер: без задержки запрос летел на каждую букву,
  // и на тысяче записей окно заметно подвисало.
  const query = useDebounced(search)

  const fetchEntries = useCallback(async () => {
    if (!connection) return
    setLoading(true)
    setError(null)
    try {
      const rows = await apiLog(connection, {
        logs: [...selectedFiles],
        levels: [...levels],
        search: query.trim() || null,
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
  }, [connection, selectedFiles, levels, query, limit])

  useEffect(() => { void fetchEntries() }, [fetchEntries])
  useAutoRefresh(auto, fetchEntries)

  /**
   * Строки готовятся один раз на выборку.
   *
   * Первая строка сообщения и признак «есть стектрейс» считались заново на
   * каждой перерисовке: тысяча записей — тысяча `split` по многокилобайтному
   * трейсу, и это на каждое нажатие клавиши.
   */
  const rows = useMemo(() => (entries ?? []).map((entry, index) => {
    const message = entry.message ?? ''
    const cut = message.indexOf('\n')
    return {
      entry,
      index,
      first: cut < 0 ? message : message.slice(0, cut),
      multiline: cut >= 0,
      message,
    }
  }), [entries])

  const counts = useMemo(() => {
    const result = new Map<string, number>()
    for (const row of rows) {
      const level = row.entry.level ?? '—'
      result.set(level, (result.get(level) ?? 0) + 1)
    }
    return result
  }, [rows])

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  return (
    <ScreenBody>
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          className="min-w-64 flex-1"
          value={search}
          placeholder={t('logs.search')}
          onChange={setSearch}
          clearLabel={t('action.clearSearch')}
        />
        <MultiSelect
          label={t('logs.level')}
          emptyLabel={t('filter.all')}
          className="w-52"
          options={LEVELS.map((level) => ({
            id: level,
            label: level,
            tone: levelTone(level),
            hint: counts.get(level) ? String(counts.get(level)) : undefined,
          }))}
          selected={levels}
          onChange={setLevels}
        />
        <MultiSelect
          label={t('logs.files')}
          emptyLabel={t('logs.files.none')}
          className="w-56"
          options={(files.data ?? []).map((file) => ({
            id: file.name,
            label: file.name,
            hint: formatBytes(file.size),
          }))}
          selected={selectedFiles}
          onChange={setSelectedFiles}
        />
        <LimitSelect value={limit} onChange={setLimit} />
        <div className="ml-auto flex items-center gap-2">
          <AutoRefreshToggle checked={auto} onChange={setAuto} />
          <RefreshButton busy={loading} disabled={loading} onClick={() => void fetchEntries()} />
        </div>
      </div>

      <ErrorBar error={error ?? files.error} />

      <Panel className="flex-1">
        <DataTable>
          <colgroup>
            <col className="w-44" />
            <col className="w-20" />
            <col className="w-56" />
            <col />
          </colgroup>
          <THead>
              <Th>{t('logs.time')}</Th>
              <Th>{t('logs.level')}</Th>
              <Th>{t('logs.source')}</Th>
              <Th>{t('logs.message')}</Th>
            </THead>
          <tbody>
            {rows.map(({ entry, index, first, multiline, message }) => {
              const open = expanded.has(index)
              return (
                <Fragment key={`${entry.timestamp ?? ''}-${index}`}>
                <tr
                  onClick={rowClick(() => { if (multiline) toggle(index) })}
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
                    <CodePill tone={levelTone(entry.level ?? '')}>{entry.level ?? '—'}</CodePill>
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
                        {first || '—'}
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
        </DataTable>
      </Panel>
    </ScreenBody>
  )
}

/** Красное и жёлтое в журнале несут смысл — уровень окрашивается и в фильтре, и в строке. */
function levelTone(level: string): Tone {
  switch (level) {
    case 'ERROR': return 'danger'
    case 'WARN': return 'warn'
    case 'INFO': return 'accent'
    default: return 'neutral'
  }
}

/** `2026-08-26T18:11:26.012` → `26.08 18:11:26.012`. */
function formatTime(value: string | null): string {
  if (!value) return '—'
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(value)
  if (!match) return value
  return `${match[3]}.${match[2]} ${match[4].slice(0, 12)}`
}

