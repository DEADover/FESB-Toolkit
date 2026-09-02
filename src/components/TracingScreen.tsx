import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ArrowCounterClockwise, DownloadSimple, Play, Stop } from '@phosphor-icons/react'

import { useI18n, type MessageKey, type Translate } from '../i18n'
import { apiRouteAction, apiRoutesOverview, errorText, revealPath, saveReport, saveXlsxAs } from '../lib/api'
import { localStamp } from '../lib/paths'
import type { Connection, RouteAction, RouteSummary, ServerInfo } from '../types'
import {
  ErrorBar, NotConnected, Panel, RefreshButton, ScreenBody, StatsBar, TableMessage, useApiData,
  useDebounced,
} from './ApiShell'
import { useToast } from './Toaster'
import {
  Badge, Button, ButtonGlyph, Checkbox, CodePill, cx, DataTable, Modal, MultiSelect, Notice, Readout, rowClick,
  SearchInput, Select, Spinner, Th, THead, Toggle,
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
  const [onlyTraced, setOnlyTraced] = useState(false)
  const [saving, setSaving] = useState(false)
  /** Отмеченные СОПС: ключ — их guid, он же приходит в действиях шины. */
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [asking, setAsking] = useState<RouteAction | null>(null)
  /**
   * Отмена долгой работы.
   *
   * Отмеченных бывает две тысячи, а запросы идут по одному: без выхода
   * ошибка в отборе стоила бы нескольких минут ожидания у окна, которое
   * ничего не предлагает.
   */
  const cancelled = useRef(false)
  const [bulk, setBulk] = useState<{
    done: number
    total: number
    failures: Array<{ row: RouteSummary; error: string }>
    finished: boolean
  } | null>(null)
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
      if (onlyTraced && !row.trace) return false
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
  }, [all, query, beans, state, onlyTraced])

  const totals = useMemo(() => ({
    routes: all.length,
    traced: all.filter((row) => row.trace).length,
    untraced: all.filter((row) => !row.trace).length,
    beans: beanOptions.length,
  }), [all, beanOptions])

  const chosen = useMemo(() => visible.filter((row) => selected.has(row.id)), [visible, selected])
  const allVisibleSelected = visible.length > 0 && visible.every((row) => selected.has(row.id))

  // Обновили список — прежние отметки указывают на строки, которых
  // на экране может уже не быть.
  useEffect(() => { setSelected(new Set()) }, [data])

  /**
   * Одно действие на все отмеченные СОПС.
   *
   * По одному запросу за раз: это живая шина, и две сотни одновременных
   * остановок она встретит хуже, чем две сотни последовательных. Неудача
   * на одном СОПС не останавливает остальные — про каждую видно в конце.
   */
  const runBulk = useCallback(async (action: RouteAction) => {
    if (!connection) return
    setAsking(null)
    const targets = chosen
    if (targets.length === 0) return
    setBulk({ done: 0, total: targets.length, failures: [], finished: false })
    cancelled.current = false

    const failures: Array<{ row: RouteSummary; error: string }> = []
    let done = 0
    for (const row of targets) {
      if (cancelled.current) break
      try {
        await apiRouteAction(connection, row.domainGuid, row.id, action)
        done += 1
      } catch (err) {
        failures.push({ row, error: errorText(err) })
      }
      setBulk({ done: done + failures.length, total: targets.length, failures, finished: false })
    }
    setBulk({ done, total: targets.length, failures, finished: true })
    await reload()
  }, [connection, chosen, reload])

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
        <Toggle checked={onlyTraced} onChange={setOnlyTraced} label={t('tracing.onlyTraced')} />
        <span className="text-[11.5px] tabular-nums text-content-subtle" title={t('tracing.hint')}>
          {t('tracing.shown', { visible: visible.length, total: all.length })}
        </span>
      </div>

      <ErrorBar error={error} />

      <Panel className="flex-1">
        <DataTable>
          <colgroup>
            <col className="w-9" />
            {COLUMNS.map((column) => (
              <col key={column.key} className={cx(column.width, column.narrow && HIDDEN_COL)} />
            ))}
          </colgroup>
          <THead>
            <Th className="w-9">
              <Checkbox
                checked={allVisibleSelected}
                title={t('tracing.selectAll')}
                onChange={(event) => setSelected(event.target.checked
                  ? new Set(visible.map((row) => row.id))
                  : new Set())}
              />
            </Th>
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
                onClick={rowClick(() => { if (row.domainGuid) onOpenRoutes(row.domainGuid) })}
                title={t('tracing.openDomain')}
                className={cx(
                  'cursor-pointer border-b border-line/60',
                  selected.has(row.id) ? 'bg-accent/8' : 'hover:bg-surface-2',
                )}
              >
                <td className="px-3 py-1.5">
                  <Checkbox
                    checked={selected.has(row.id)}
                    onChange={(event) => setSelected((prev) => {
                      const next = new Set(prev)
                      if (event.target.checked) next.add(row.id)
                      else next.delete(row.id)
                      return next
                    })}
                  />
                </td>
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
                    // Прочерк, а не подпись: строк без трассировки триста,
                    // и цветные слова в каждой седьмой строке — это шум.
                    // Сколько их всего, сказано в сводке над таблицей.
                    <span className="text-content-subtle">—</span>
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
              <TableMessage colSpan={COLUMNS.length + 1} busy={loading}>{loading ? t('empty.scanning') : t('tracing.nothing')}
              </TableMessage>
            )}
          </tbody>
        </DataTable>
      </Panel>

      <div className="flex flex-wrap items-center gap-2">
        {chosen.length > 0 ? (
          <>
            <Badge tone="accent">{t('tracing.selected', { count: chosen.length })}</Badge>
            <Button size="sm" disabled={bulk !== null} onClick={() => void runBulk('start')}>
              <ButtonGlyph><Play size={13} weight="bold" /></ButtonGlyph>
              {t('modules.start')}
            </Button>
            <Button size="sm" disabled={bulk !== null} onClick={() => setAsking('stop')}>
              <ButtonGlyph><Stop size={13} weight="bold" /></ButtonGlyph>
              {t('modules.stop')}
            </Button>
            <Button size="sm" disabled={bulk !== null} onClick={() => setAsking('reset')}>
              <ButtonGlyph><ArrowCounterClockwise size={13} weight="bold" /></ButtonGlyph>
              {t('routes.reset')}
            </Button>
          </>
        ) : (
          <span className="text-[11.5px] text-content-subtle">{t('tracing.bulk.hint')}</span>
        )}
      </div>

      <Modal
        open={asking !== null}
        onClose={() => setAsking(null)}
        closeLabel={t('action.close')}
        title={asking === 'reset' ? t('tracing.bulk.confirmReset') : t('tracing.bulk.confirmStop')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsking(null)}>{t('action.cancel')}</Button>
            <Button variant="primary" onClick={() => asking && void runBulk(asking)}>
              {asking === 'reset' ? t('routes.reset') : t('modules.stop')}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <Notice tone="warn" small>
            {asking === 'reset' ? t('tracing.bulk.confirmResetHint') : t('tracing.bulk.confirmStopHint')}
          </Notice>
          <div className="text-[11.5px] text-content-subtle">
            {t('tracing.bulk.title', { count: chosen.length })}
          </div>
        </div>
      </Modal>

      <Modal
        open={bulk !== null}
        onClose={() => { if (bulk?.finished) { setBulk(null); setSelected(new Set()) } }}
        closeLabel={t('action.close')}
        title={t('tracing.bulk.title', { count: bulk?.total ?? 0 })}
        footer={
          <Button
            variant="ghost"
            onClick={() => {
              if (bulk?.finished) { setBulk(null); setSelected(new Set()) } else cancelled.current = true
            }}
          >
            {bulk?.finished ? t('action.close') : t('action.cancel')}
          </Button>
        }
      >
        {bulk && (
          <div className="space-y-3">
            {bulk.finished ? (
              <Notice tone={bulk.failures.length > 0 ? 'warn' : 'ok'} small>
                {t('tracing.bulk.done', { done: bulk.done })}
                {bulk.failures.length > 0 && ` · ${t('tracing.bulk.failed', { count: bulk.failures.length })}`}
              </Notice>
            ) : (
              <div className="flex items-center gap-2 text-[12px] text-content-muted">
                <Spinner className="size-4" />
                {t('tracing.bulk.running', { current: bulk.done, total: bulk.total })}
              </div>
            )}
            {bulk.failures.length > 0 && (
              <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
                {bulk.failures.map((failure) => (
                  <div key={failure.row.id} className="border-b border-line/60 px-2.5 py-1.5 last:border-b-0">
                    <div className="flex items-baseline gap-2 text-[11px] text-content-subtle">
                      <span className="truncate">{failure.row.domain}</span>
                      <span className="truncate font-medium text-content">{failure.row.name}</span>
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-negative">{failure.error}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
    </ScreenBody>
  )
}
