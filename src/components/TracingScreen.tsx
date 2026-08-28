import { useCallback, useMemo, useState } from 'react'

import { DownloadSimple } from '@phosphor-icons/react'

import { useI18n, type MessageKey, type Translate } from '../i18n'
import { apiRoutesOverview, errorText, revealPath, saveReport, saveXlsxAs } from '../lib/api'
import { localStamp } from '../lib/paths'
import type { Connection, RouteSummary, ServerInfo } from '../types'
import {
  ErrorBar, NotConnected, Panel, RefreshButton, ScreenBody, StatsBar, TableMessage, useApiData,
  useDebounced,
} from './ApiShell'
import { useToast } from './Toaster'
import {
  Badge, Button, ButtonGlyph, CodePill, cx, DataTable, MultiSelect, Readout, SearchInput, Select,
  Th, THead, Toggle,
} from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  onGoToConnection: () => void
  onOpenRoutes: (domainGuid: string) => void
}

type State = 'all' | 'started' | 'stopped'

/**
 * Колонки: один список на таблицу и на файл.
 *
 * Имя СОПС берёт остаток ширины — ради него экран и открывают. Счётчики
 * уходят на узком окне: здесь спрашивают «через что трассируется», а числа
 * по каждому маршруту живут на экране СОПС. В файл они уходят всегда,
 * независимо от ширины окна.
 */
const COLUMNS: Array<{
  key: MessageKey
  /** Пусто — колонка забирает остаток ширины. */
  width: string
  align?: 'right'
  /** Прячется, пока окно уже `xl`. */
  narrow?: boolean
  text: (row: RouteSummary, t: Translate) => string
}> = [
  { key: 'table.domain', width: 'w-40', text: (row) => row.domain },
  { key: 'table.route', width: '', text: (row) => row.name },
  { key: 'tracing.state', width: 'w-24', text: (row) => row.state },
  { key: 'tracing.bean', width: 'w-44', text: (row) => row.traceBeans.join(', ') },
  { key: 'tracing.tags', width: 'w-28', narrow: true, text: (row) => row.tags.join(', ') },
  { key: 'routes.processed', width: 'w-28', align: 'right', narrow: true, text: (row) => String(row.processed) },
  { key: 'map.errors', width: 'w-24', align: 'right', narrow: true, text: (row) => String(row.failed) },
  { key: 'map.inflight', width: 'w-24', align: 'right', narrow: true, text: (row) => String(row.inflight) },
]

/** Классы скрытия — одни и те же у `col`, `th` и `td`, иначе колонки разъедутся. */
const HIDDEN_COL = 'hidden xl:table-column'
const HIDDEN_CELL = 'hidden xl:table-cell'

/**
 * Трассировка по всему серверу.
 *
 * Главный вопрос инструмента — «где какая трассировка» — до сих пор стоил
 * полной выгрузки конфигурации: полторы минуты на стенде из двухсот
 * пятидесяти доменов. Оказалось, шина отвечает на него одним запросом
 * за доли секунды, и отвечает про все СОПС, включая остановленные.
 *
 * Поэтому здесь нет кнопки «собрать»: список читается при открытии экрана
 * и обновляется по кнопке, как везде.
 */
export function TracingScreen({ connection, server, onGoToConnection, onOpenRoutes }: Props) {
  const { t } = useI18n()
  const toast = useToast()
  const load = useCallback((open: Connection) => apiRoutesOverview(open), [])
  const { data, loading, error, reload, setError } = useApiData<RouteSummary[]>(connection, load)

  const [search, setSearch] = useState('')
  const [beans, setBeans] = useState<Set<string>>(new Set())
  const [state, setState] = useState<State>('all')
  const [onlyUntraced, setOnlyUntraced] = useState(false)
  const [saving, setSaving] = useState(false)
  const query = useDebounced(search, 250)

  const all = useMemo(() => data ?? [], [data])

  /** Объекты трассировки со счётчиками: сразу видно, какой из них главный. */
  const beanOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of all) {
      for (const bean of row.traceBeans) counts.set(bean, (counts.get(bean) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, count]) => ({ id, label: id, hint: String(count) }))
  }, [all])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return all.filter((row) => {
      if (onlyUntraced && row.trace) return false
      if (state === 'started' && row.state !== 'Started') return false
      if (state === 'stopped' && row.state === 'Started') return false
      if (beans.size > 0 && !row.traceBeans.some((bean) => beans.has(bean))) return false
      if (!needle) return true
      return (
        row.domain.toLowerCase().includes(needle) ||
        row.name.toLowerCase().includes(needle) ||
        row.traceBeans.some((bean) => bean.toLowerCase().includes(needle))
      )
    })
  }, [all, query, beans, state, onlyUntraced])

  const totals = useMemo(() => ({
    routes: all.length,
    traced: all.filter((row) => row.trace).length,
    untraced: all.filter((row) => !row.trace).length,
    beans: beanOptions.length,
  }), [all, beanOptions])

  /** В файл уходит то, что видно на экране: фильтры — часть списка. */
  const exportXlsx = useCallback(async () => {
    const headers = COLUMNS.map((column) => t(column.key))
    const body = visible.map((row) => COLUMNS.map((column) => column.text(row, t)))

    const output = await saveXlsxAs(t('tracing.save'), `fesb-tracing-${localStamp()}.xlsx`)
    if (!output) return
    setSaving(true)
    setError(null)
    try {
      await saveReport(output, t('nav.api.tracing'), headers, body)
      toast({
        tone: 'ok',
        title: t('report.saved'),
        text: `${output.split(/[/\\]/).pop()} · ${t('report.savedRows', { count: body.length })}`,
        action: { label: t('action.reveal'), onClick: () => void revealPath(output) },
      })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }, [visible, t, toast, setError])

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  return (
    <ScreenBody>
      <StatsBar>
        <Readout label={t('tracing.routes')} value={totals.routes.toLocaleString()} />
        <Readout label={t('tracing.traced')} value={totals.traced.toLocaleString()} tone="accent" />
        <Readout
          label={t('tracing.untraced')}
          value={totals.untraced.toLocaleString()}
          tone={totals.untraced > 0 ? 'warn' : undefined}
        />
        <Readout
          label={t('tracing.beans')}
          value={totals.beans.toLocaleString()}
          hint={t('tracing.beans.hint')}
        />
        <div className="ml-auto flex items-center gap-2">
          <RefreshButton className="min-w-32" busy={loading} onClick={() => void reload()} />
          <Button
            variant="primary"
            className="min-w-52"
            disabled={saving || visible.length === 0}
            onClick={() => void exportXlsx()}
          >
            <ButtonGlyph busy={saving}><DownloadSimple size={14} weight="bold" /></ButtonGlyph>
            {t('tracing.export', { count: visible.length })}
          </Button>
        </div>
      </StatsBar>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          className="min-w-64 flex-1"
          value={search}
          placeholder={t('tracing.search')}
          onChange={setSearch}
          clearLabel={t('action.clearSearch')}
        />
        <MultiSelect
          label={t('tracing.bean')}
          emptyLabel={t('filter.all')}
          className="w-64"
          options={beanOptions}
          selected={beans}
          onChange={setBeans}
        />
        <Select<State>
          ariaLabel={t('tracing.state')}
          label={t('tracing.state')}
          className="w-48"
          value={state}
          onChange={setState}
          options={[
            { id: 'all', label: t('filter.all') },
            { id: 'started', label: t('tracing.started') },
            { id: 'stopped', label: t('table.stopped') },
          ]}
        />
        <Toggle checked={onlyUntraced} onChange={setOnlyUntraced} label={t('tracing.onlyUntraced')} />
        <span className="text-[11.5px] tabular-nums text-content-subtle" title={t('tracing.hint')}>
          {t('tracing.shown', { visible: visible.length, total: all.length })}
        </span>
      </div>

      <ErrorBar error={error} />

      <Panel className="flex-1">
        <DataTable>
          <colgroup>
            {COLUMNS.map((column) => (
              <col key={column.key} className={cx(column.width, column.narrow && HIDDEN_COL)} />
            ))}
          </colgroup>
          <THead>
            {COLUMNS.map((column) => (
              <Th
                key={column.key}
                align={column.align}
                className={cx('whitespace-nowrap', column.narrow && HIDDEN_CELL)}
              >
                {t(column.key)}
              </Th>
            ))}
          </THead>
          <tbody>
            {visible.map((row) => (
              <tr
                key={row.id}
                onClick={() => row.domainGuid && onOpenRoutes(row.domainGuid)}
                title={t('tracing.openDomain')}
                className="cursor-pointer border-b border-line/60 hover:bg-surface-2"
              >
                <td className="truncate px-3 py-1.5">{row.domain || '—'}</td>
                <td className="truncate px-3 py-1.5 font-medium" title={row.name}>{row.name || '—'}</td>
                <td className="px-3 py-1.5">
                  <Badge tone={row.state === 'Started' ? 'ok' : 'neutral'}>{row.state || '—'}</Badge>
                </td>
                <td className="truncate px-3 py-1.5" title={row.traceBeans.join(', ')}>
                  {row.traceBeans.length > 0 ? (
                    <span className="flex flex-wrap items-center gap-1">
                      {row.traceBeans.map((bean) => <CodePill key={bean}>{bean}</CodePill>)}
                    </span>
                  ) : (
                    // Отсутствие трассировки — это и есть то, что здесь ищут.
                    <span className="text-[11.5px] text-caution">{t('tracing.none')}</span>
                  )}
                </td>
                <td className={cx('truncate px-3 py-1.5 text-[11.5px] text-content-muted', HIDDEN_CELL)}>
                  {row.tags.join(', ') || '—'}
                </td>
                <td className={cx('px-3 py-1.5 text-right tabular-nums text-content-muted', HIDDEN_CELL)}>
                  {row.processed.toLocaleString()}
                </td>
                <td className={cx('px-3 py-1.5 text-right tabular-nums', HIDDEN_CELL, row.failed > 0 && 'font-medium text-negative')}>
                  {row.failed.toLocaleString()}
                </td>
                <td className={cx('px-3 py-1.5 text-right tabular-nums', HIDDEN_CELL, row.inflight > 0 && 'font-medium text-caution')}>
                  {row.inflight.toLocaleString()}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <TableMessage colSpan={COLUMNS.length}>
                {loading ? t('empty.scanning') : t('tracing.nothing')}
              </TableMessage>
            )}
          </tbody>
        </DataTable>
      </Panel>
    </ScreenBody>
  )
}
