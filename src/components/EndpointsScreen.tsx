import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import { CaretRight, DownloadSimple, Trash } from '@phosphor-icons/react'

import { useI18n, type MessageKey, type Translate } from '../i18n'
import {
  apiEndpointReport, deleteReportHistory, errorText, onApiProgress, readReportHistory, reportHistory,
  revealPath, saveReport, saveReportHistory, saveXlsxAs,
} from '../lib/api'
import { localStamp, localTime } from '../lib/paths'
import type { ApiEndpoint, ApiProgress, Connection, ReportEntry, ServerInfo } from '../types'
import { ErrorBar, NotConnected, Panel, ScreenBody, StatsBar, TableMessage, useDebounced } from './ApiShell'
import { useToast } from './Toaster'
import {
  Badge, Button, ButtonGlyph, CodePill, cx, DataTable, EmptyState, FOCUS_RING, IconButton,
  MultiSelect, Readout, rowClick, SearchInput, Select, Spinner, Th, THead, Toggle,
} from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  onGoToConnection: () => void
}

type Direction = 'all' | 'in' | 'out'
type Grouping = 'none' | 'host' | 'domain'

/** Группа строк отчёта: заголовок и то, что под ним. */
interface Group {
  key: string
  title: string
  rows: ApiEndpoint[]
}


/**
 * Колонки отчёта: один список на таблицу и на файл.
 *
 * Раньше они задавались в двух местах и разошлись: в таблице было восемь
 * колонок, в файле — четырнадцать. `width` — ширина в таблице; таблица
 * прокручивается по горизонтали, поэтому прятать колонки на узком окне
 * не нужно, а вот сжимать их до нечитаемости — нельзя.
 */
const COLUMNS: Array<{
  key: MessageKey
  width: string
  align?: 'right'
  /** Почему колонка бывает пустой — подсказка у её заголовка. */
  hint?: MessageKey
  /** Как значение выглядит в таблице. По умолчанию — как в файле. */
  cell?: (row: ApiEndpoint, t: Translate) => ReactNode
  text: (row: ApiEndpoint, t: Translate) => string
}> = [
  { key: 'table.domain', width: 'w-52', text: (row) => row.domain },
  { key: 'endpoints.domainGuid', width: 'w-72', text: (row) => row.domainGuid,
    cell: (row) => <span className="font-mono text-[10.5px] text-content-subtle">{row.domainGuid}</span> },
  { key: 'table.route', width: 'w-64', text: (row) => row.route },
  { key: 'endpoints.routeId', width: 'w-72', text: (row) => row.routeId,
    cell: (row) => <span className="font-mono text-[10.5px] text-content-subtle">{row.routeId}</span> },
  { key: 'endpoints.kind', width: 'w-24', text: (row) => row.kind,
    cell: (row) => <CodePill>{row.kind}</CodePill> },
  { key: 'endpoints.direction', width: 'w-24',
    text: (row, t) => (row.direction === 'in' ? t('endpoints.in') : t('endpoints.out')),
    cell: (row, t) => (
      <Badge tone={row.direction === 'in' ? 'accent' : 'neutral'}>
        {row.direction === 'in' ? t('endpoints.in') : t('endpoints.out')}
      </Badge>
    ) },
  { key: 'route.uri', width: 'w-[34rem]', text: (row) => row.uri,
    cell: (row) => (
      <span className="line-clamp-2 break-all font-mono text-[11px] leading-4 text-content-muted">{row.uri}</span>
    ) },
  { key: 'endpoints.manager', width: 'w-36', hint: 'endpoints.manager.hint',
    text: (row) => row.manager ?? '',
    cell: (row) => (row.manager === null
      ? <span className="text-content-subtle">—</span>
      : <CodePill>{row.manager}</CodePill>) },
  { key: 'endpoints.port', width: 'w-16', align: 'right',
    text: (row) => (row.port === null ? '' : String(row.port)) },
  { key: 'endpoints.listening', width: 'w-28', hint: 'endpoints.listening.hint',
    text: (row, t) => (row.listening === null
      ? ''
      : row.listening ? t('endpoints.yes') : t('endpoints.listening.no')),
    cell: (row, t) => (row.listening === null
      ? <span className="text-content-subtle">—</span>
      // Свободный порт у точки входа — находка: там никто не слушает.
      : <Badge tone={row.listening ? 'ok' : 'warn'}>
          {row.listening ? t('endpoints.yes') : t('endpoints.listening.no')}
        </Badge>) },
  { key: 'endpoints.protocol', width: 'w-32', hint: 'endpoints.protocol.hint', text: (row) => row.protocol ?? '' },
  { key: 'endpoints.ssl', width: 'w-20',
    text: (row, t) => (row.ssl === null ? '' : row.ssl ? t('endpoints.yes') : t('endpoints.no')),
    cell: (row, t) => (row.ssl === null
      ? <span className="text-content-subtle">—</span>
      : <Badge tone={row.ssl ? 'ok' : 'warn'}>{row.ssl ? t('endpoints.yes') : t('endpoints.no')}</Badge>) },
  { key: 'endpoints.ciphers', width: 'w-56', hint: 'endpoints.ciphers.hint', text: (row) => row.ciphers ?? '' },
  { key: 'endpoints.auth', width: 'w-32', text: (row) => row.auth ?? '' },
  { key: 'table.state', width: 'w-28', text: (row) => row.state ?? '' },
  { key: 'endpoints.uptime', width: 'w-24', hint: 'endpoints.uptime.hint', text: (row) => row.uptime ?? '' },
  { key: 'endpoints.busy', width: 'w-24', align: 'right', text: (row) => number(row.busyThreads) },
  { key: 'endpoints.utilized', width: 'w-28', align: 'right', text: (row) => number(row.utilizedThreads) },
  { key: 'endpoints.ready', width: 'w-28', align: 'right', text: (row) => number(row.readyThreads) },
  { key: 'endpoints.min', width: 'w-28', align: 'right', text: (row) => number(row.minThreads) },
  { key: 'endpoints.max', width: 'w-28', align: 'right', text: (row) => number(row.maxThreads) },
  { key: 'endpoints.queue', width: 'w-28', align: 'right', text: (row) => number(row.queueSize) },
  { key: 'endpoints.idleTimeout', width: 'w-28', align: 'right', text: (row) => number(row.idleTimeout) },
  { key: 'endpoints.idle', width: 'w-28', align: 'right', text: (row) => number(row.idleThreads) },
]

function number(value: number | null): string {
  return value === null ? '' : String(value)
}

/**
 * Отчёт по внешним точкам входа и выхода.
 *
 * Вопрос, ради которого он нужен, — «через какие адреса шина разговаривает
 * с внешним миром и как эти адреса защищены». Собирается он не мгновенно:
 * состав точек лежит в самих СОПС, а СОПС приходится выкачать целиком,
 * поэтому отчёт строится по кнопке, а не открывается сам.
 */
export function EndpointsScreen({ connection, server, onGoToConnection }: Props) {
  const { t } = useI18n()
  const toast = useToast()
  const [rows, setRows] = useState<ApiEndpoint[] | null>(null)
  /** Какой отчёт сейчас открыт: собранный только что или взятый из истории. */
  const [openedAt, setOpenedAt] = useState<string | null>(null)
  const [history, setHistory] = useState<ReportEntry[]>([])
  const [building, setBuilding] = useState(false)
  const [progress, setProgress] = useState<ApiProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [search, setSearch] = useState('')
  const [direction, setDirection] = useState<Direction>('all')
  const [schemes, setSchemes] = useState<Set<string>>(new Set())
  const [onlySecured, setOnlySecured] = useState(false)
  const [onlyDeaf, setOnlyDeaf] = useState(false)
  const [grouping, setGrouping] = useState<Grouping>('host')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const query = useDebounced(search, 250)

  // История лежит на диске и переживает и переход, и перезапуск, поэтому
  // читается при открытии экрана, а не собирается заново.
  useEffect(() => {
    reportHistory().then(setHistory).catch(() => setHistory([]))
  }, [])

  const build = useCallback(async () => {
    if (!connection || !server) return
    setBuilding(true)
    setError(null)
    setProgress(null)
    const stop = await onApiProgress(setProgress)
    try {
      const points = await apiEndpointReport(connection)
      const builtAt = localTime()
      setRows(points)
      setOpenedAt(builtAt)
      // Полторы минуты работы не должны пропадать от перехода на соседний
      // экран: отчёт сразу ложится в историю.
      setHistory(await saveReportHistory(server.baseUrl, builtAt, points))
    } catch (err) {
      setError(errorText(err))
      setRows(null)
    } finally {
      void stop()
      setBuilding(false)
      setProgress(null)
    }
  }, [connection, server])

  const openStored = useCallback(async (entry: ReportEntry) => {
    setError(null)
    try {
      const stored = await readReportHistory(entry.id)
      setRows(stored.endpoints)
      setOpenedAt(stored.builtAt)
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  const forget = useCallback(async (entry: ReportEntry) => {
    try {
      setHistory(await deleteReportHistory(entry.id))
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  /** История этого стенда: чужие отчёты в списке только мешают. */
  const mine = useMemo(
    () => history.filter((entry) => entry.server === server?.baseUrl),
    [history, server],
  )

  const all = useMemo(() => rows ?? [], [rows])

  const schemeOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of all) counts.set(row.scheme, (counts.get(row.scheme) ?? 0) + 1)
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, count]) => ({ id, label: id, hint: String(count) }))
  }, [all])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return all.filter((row) => {
      if (direction !== 'all' && row.direction !== direction) return false
      if (schemes.size > 0 && !schemes.has(row.scheme)) return false
      if (onlySecured && row.ssl !== true) return false
      if (onlyDeaf && row.listening !== false) return false
      if (!needle) return true
      return (
        row.domain.toLowerCase().includes(needle) ||
        row.route.toLowerCase().includes(needle) ||
        row.uri.toLowerCase().includes(needle) ||
        (row.host ?? '').toLowerCase().includes(needle) ||
        (row.manager ?? '').toLowerCase().includes(needle)
      )
    })
  }, [all, query, direction, schemes, onlySecured, onlyDeaf])

  /**
   * Группировка списка.
   *
   * Отчёт читают не подряд, а по системам: «с кем мы вообще разговариваем
   * и сколько раз». Хост для этого — главный ключ, домен — второй по частоте.
   * Адреса из констант хоста не имеют, и складывать их в «без хоста» честнее,
   * чем прятать.
   */
  const groups = useMemo<Group[]>(() => {
    if (grouping === 'none') return [{ key: '', title: '', rows: visible }]
    const buckets = new Map<string, ApiEndpoint[]>()
    for (const row of visible) {
      // У локальной очереди хоста нет, а собеседник есть — менеджер очередей.
      // Без этого все localmq свалились бы в «без хоста» одной кучей.
      const key = grouping === 'host' ? row.host ?? row.manager ?? '' : row.domain
      const list = buckets.get(key)
      if (list) list.push(row)
      else buckets.set(key, [row])
    }
    return [...buckets.entries()]
      .map(([key, rows]) => ({ key, title: key || t('endpoints.noHost'), rows }))
      .sort((a, b) => {
        // Безымянная группа всегда внизу: это не система, а «не разобрали».
        if (!a.key !== !b.key) return a.key ? -1 : 1
        return b.rows.length - a.rows.length || a.title.localeCompare(b.title)
      })
  }, [visible, grouping, t])

  const allCollapsed = groups.length > 0 && groups.every((group) => collapsed.has(group.key))

  const toggleGroup = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const totals = useMemo(() => ({
    points: all.length,
    inbound: all.filter((row) => row.direction === 'in').length,
    systems: new Set(all.map((row) => row.host).filter(Boolean)).size,
    secured: all.filter((row) => row.ssl === true).length,
  }), [all])

  /** В файл уходит то, что видно на экране: фильтры — часть отчёта. */
  const exportXlsx = useCallback(async () => {
    const headers = COLUMNS.map((column) => t(column.key))
    const body = visible.map((row) => COLUMNS.map((column) => column.text(row, t)))

    const output = await saveXlsxAs(t('endpoints.save'), `fesb-endpoints-${localStamp()}.xlsx`)
    if (!output) return
    setSaving(true)
    setError(null)
    try {
      await saveReport(output, t('nav.api.endpoints'), headers, body)
      // Раньше выгрузка заканчивалась молча: диалог закрылся — и всё.
      // Теперь видно, что файл записан, и до него один щелчок.
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
  }, [visible, t, toast])

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  if (rows === null) {
    return (
      <ScreenBody>
        <ErrorBar error={error} />
        <EmptyState
          icon={DownloadSimple}
          title={mine.length > 0 ? t('endpoints.history.pick') : t('endpoints.empty')}
          text={t('endpoints.empty.text')}
          action={
            <Button variant="primary" className="min-w-44" disabled={building} onClick={() => void build()}>
              {building ? <><Spinner className="size-4" /> {t('endpoints.building')}</> : t('endpoints.build')}
            </Button>
          }
        >
          {building && progress && (
            <p className="mt-3 text-[11.5px] tabular-nums text-content-subtle">
              {t('routes.indexing', { current: progress.current, total: progress.total })}
            </p>
          )}

          {/* Собранное раньше — здесь же: заново полторы минуты ждать незачем. */}
          {!building && mine.length > 0 && (
            <div className="mt-7 w-[26rem] text-left">
              <div
                className="mb-2 text-[11px] tracking-wide text-content-subtle"
                title={t('endpoints.history.hint')}
              >
                {t('endpoints.history')}
              </div>
              <div className="overflow-hidden rounded-xl border border-line">
                {mine.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center gap-2 border-b border-line/60 px-3 py-2 last:border-b-0 hover:bg-surface-2"
                  >
                    <button
                      type="button"
                      onClick={() => void openStored(entry)}
                      title={t('endpoints.openStored')}
                      className={cx('min-w-0 flex-1 text-left', FOCUS_RING)}
                    >
                      <div className="truncate text-[12.5px] tabular-nums">{readableTime(entry.builtAt)}</div>
                      <div className="truncate text-[11px] tabular-nums text-content-subtle">
                        {t('endpoints.history.line', { points: entry.points, hosts: entry.hosts })}
                      </div>
                    </button>
                    <IconButton icon={Trash} label={t('endpoints.forget')} onClick={() => void forget(entry)} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </EmptyState>
      </ScreenBody>
    )
  }

  return (
    <ScreenBody>
      <StatsBar>
        <Readout label={t('endpoints.total')} value={totals.points.toLocaleString()} />
        <Readout label={t('endpoints.in')} value={totals.inbound.toLocaleString()} tone="accent" />
        <Readout label={t('endpoints.systems')} value={totals.systems.toLocaleString()} hint={t('endpoints.systems.hint')} />
        <Readout label={t('endpoints.secured')} value={totals.secured.toLocaleString()} />
        {openedAt && (
          <Readout
            label={t('endpoints.builtAt')}
            value={<span className="text-[13px] tabular-nums">{readableTime(openedAt)}</span>}
            hint={t('endpoints.fromHistory')}
          />
        )}
        <div className="ml-auto flex items-center gap-2">
          {mine.length > 0 && (
            <Button className="min-w-32" onClick={() => { setRows(null); setOpenedAt(null) }}>
              {t('endpoints.backToHistory')}
            </Button>
          )}
          <Button className="min-w-36" disabled={building} onClick={() => void build()}>
            {building ? <><Spinner className="size-4" /> {t('endpoints.building')}</> : t('endpoints.rebuild')}
          </Button>
          <Button variant="primary" className="min-w-52" disabled={saving || visible.length === 0} onClick={() => void exportXlsx()}>
            <ButtonGlyph busy={saving}><DownloadSimple size={14} weight="bold" /></ButtonGlyph>
            {t('endpoints.export', { count: visible.length })}
          </Button>
        </div>
      </StatsBar>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          className="min-w-64 flex-1"
          value={search}
          placeholder={t('endpoints.search')}
          onChange={setSearch}
          clearLabel={t('action.clearSearch')}
        />
        <Select<Direction>
          ariaLabel={t('endpoints.direction')}
          label={t('endpoints.direction')}
          value={direction}
          onChange={setDirection}
          options={[
            { id: 'all', label: t('filter.all') },
            { id: 'in', label: t('endpoints.in') },
            { id: 'out', label: t('endpoints.out') },
          ]}
        />
        <MultiSelect
          label={t('endpoints.scheme')}
          emptyLabel={t('filter.all')}
          className="w-56"
          options={schemeOptions}
          selected={schemes}
          onChange={setSchemes}
        />
        <Toggle checked={onlySecured} onChange={setOnlySecured} label={t('endpoints.onlySecured')} />
        <Toggle
          checked={onlyDeaf}
          onChange={setOnlyDeaf}
          label={t('endpoints.onlyDeaf')}
          title={t('endpoints.onlyDeaf.hint')}
        />
        {grouping !== 'none' && (
          <Button
            className="min-w-36"
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groups.map((group) => group.key)))}
          >
            {allCollapsed ? t('endpoints.expandAll') : t('endpoints.collapseAll')}
          </Button>
        )}
        <Select<Grouping>
          ariaLabel={t('endpoints.group')}
          label={t('endpoints.group')}
          value={grouping}
          onChange={setGrouping}
          options={[
            { id: 'host', label: t('endpoints.host') },
            { id: 'domain', label: t('table.domain') },
            { id: 'none', label: t('endpoints.group.none') },
          ]}
        />
      </div>

      <ErrorBar error={error} />

      <Panel className="flex-1">
        <DataTable wide>
          {/* Все колонки видны всегда: таблица прокручивается по горизонтали.
              Прятать их на узком окне нельзя — отчёт затем и нужен, чтобы
              увидеть весь набор, а сдвинувшиеся заголовки уже путали. */}
          <colgroup>
            {COLUMNS.map((column) => <col key={column.key} className={column.width} />)}
          </colgroup>
          <THead>
            {COLUMNS.map((column) => (
              <Th
                key={column.key}
                align={column.align}
                title={column.hint ? t(column.hint) : undefined}
                className="whitespace-nowrap"
              >
                {t(column.key)}
              </Th>
            ))}
          </THead>
          <tbody>
            {groups.map((group) => (
              <Fragment key={group.key || 'all'}>
                {/* Заголовок группы — строка таблицы, а не отдельный список:
                    иначе колонки под каждой группой разъезжались бы. */}
                {grouping !== 'none' && (
                  <tr
                    onClick={rowClick(() => toggleGroup(group.key))}
                    className="cursor-pointer border-b border-line bg-surface-2/70 hover:bg-surface-3"
                  >
                    <td colSpan={COLUMNS.length} className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        {/* Кнопка, а не только клик по строке: с клавиатуры
                            до сворачивания иначе не добраться. */}
                        <button
                          type="button"
                          aria-expanded={!collapsed.has(group.key)}
                          aria-label={collapsed.has(group.key) ? t('endpoints.expand') : t('endpoints.collapse')}
                          title={collapsed.has(group.key) ? t('endpoints.expand') : t('endpoints.collapse')}
                          onClick={(event) => { event.stopPropagation(); toggleGroup(group.key) }}
                          className={cx('grid size-5 shrink-0 place-items-center rounded transition hover:bg-surface-3', FOCUS_RING)}
                        >
                          <CaretRight
                            size={11}
                            weight="bold"
                            className={cx('text-content-subtle transition-transform', !collapsed.has(group.key) && 'rotate-90')}
                          />
                        </button>
                        <span className={cx('min-w-0 truncate text-[12.5px] font-semibold', !group.key && 'text-content-subtle')}>
                          {group.title}
                        </span>
                        <Badge>{group.rows.length}</Badge>
                        {group.rows.some((row) => row.direction === 'in') && (
                          <Badge tone="accent">
                            {t('endpoints.in')} · {group.rows.filter((row) => row.direction === 'in').length}
                          </Badge>
                        )}
                      </div>
                    </td>
                  </tr>
                )}

                {!collapsed.has(group.key) && group.rows.map((row, index) => (
              <tr key={`${row.domainGuid}-${row.routeId}-${index}`} className="border-b border-line/60 align-top hover:bg-surface-2">
                {COLUMNS.map((column) => (
                  <td
                    key={column.key}
                    className={cx('px-3 py-1.5', column.align === 'right' ? 'text-right tabular-nums' : 'truncate')}
                    title={column.text(row, t)}
                  >
                    {column.cell ? column.cell(row, t) : column.text(row, t) || '—'}
                  </td>
                ))}
              </tr>
                ))}
              </Fragment>
            ))}
            {visible.length === 0 && <TableMessage colSpan={COLUMNS.length}>{t('endpoints.nothing')}</TableMessage>}
          </tbody>
        </DataTable>
      </Panel>
    </ScreenBody>
  )
}

/** `2026-08-27T21:15:04` → `27.08.2026 21:15`: секунды в списке не нужны. */
function readableTime(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2})/.exec(value)
  return match ? `${match[3]}.${match[2]}.${match[1]} ${match[4]}` : value
}
