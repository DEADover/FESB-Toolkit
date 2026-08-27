import { Fragment, useCallback, useMemo, useState } from 'react'

import { CaretRight, DownloadSimple } from '@phosphor-icons/react'

import { useI18n } from '../i18n'
import { apiEndpointReport, errorText, onApiProgress, saveReport, saveXlsxAs } from '../lib/api'
import { localStamp } from '../lib/paths'
import type { ApiEndpoint, ApiProgress, Connection, ServerInfo } from '../types'
import { ErrorBar, NotConnected, Panel, ScreenBody, TableMessage, useDebounced } from './ApiShell'
import {
  Badge, Button, ButtonGlyph, CodePill, cx, DataTable, EmptyState, MultiSelect, Readout, rowClick, SearchInput, Select, Spinner, Th, THead, Toggle,
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
 * Отчёт по внешним точкам входа и выхода.
 *
 * Вопрос, ради которого он нужен, — «через какие адреса шина разговаривает
 * с внешним миром и как эти адреса защищены». Собирается он не мгновенно:
 * состав точек лежит в самих СОПС, а СОПС приходится выкачать целиком,
 * поэтому отчёт строится по кнопке, а не открывается сам.
 */
export function EndpointsScreen({ connection, server, onGoToConnection }: Props) {
  const { t } = useI18n()
  const [rows, setRows] = useState<ApiEndpoint[] | null>(null)
  const [building, setBuilding] = useState(false)
  const [progress, setProgress] = useState<ApiProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [search, setSearch] = useState('')
  const [direction, setDirection] = useState<Direction>('all')
  const [schemes, setSchemes] = useState<Set<string>>(new Set())
  const [onlySecured, setOnlySecured] = useState(false)
  const [grouping, setGrouping] = useState<Grouping>('host')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const query = useDebounced(search, 250)

  const build = useCallback(async () => {
    if (!connection) return
    setBuilding(true)
    setError(null)
    setProgress(null)
    const stop = await onApiProgress(setProgress)
    try {
      setRows(await apiEndpointReport(connection))
    } catch (err) {
      setError(errorText(err))
      setRows(null)
    } finally {
      void stop()
      setBuilding(false)
      setProgress(null)
    }
  }, [connection])

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
      if (!needle) return true
      return (
        row.domain.toLowerCase().includes(needle) ||
        row.route.toLowerCase().includes(needle) ||
        row.uri.toLowerCase().includes(needle) ||
        (row.host ?? '').toLowerCase().includes(needle)
      )
    })
  }, [all, query, direction, schemes, onlySecured])

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
      const key = grouping === 'host' ? row.host ?? '' : row.domain
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
    const headers = [
      t('table.domain'), t('table.route'), t('endpoints.component'), t('endpoints.direction'),
      t('endpoints.scheme'), t('route.uri'), t('endpoints.host'), t('endpoints.port'),
      t('endpoints.ssl'), t('endpoints.protocol'), t('endpoints.ciphers'), t('endpoints.auth'),
      t('table.state'), t('endpoints.threads'),
    ]
    const body = visible.map((row) => [
      row.domain, row.route, row.component,
      row.direction === 'in' ? t('endpoints.in') : t('endpoints.out'),
      row.scheme, row.uri, row.host ?? '', row.port === null ? '' : String(row.port),
      row.ssl === null ? '' : row.ssl ? t('endpoints.yes') : t('endpoints.no'),
      row.protocol ?? '', row.ciphers ?? '', row.auth ?? '', row.state ?? '',
      row.busyThreads === null ? '' : `${row.busyThreads} / ${row.maxThreads ?? '?'}`,
    ])

    const output = await saveXlsxAs(t('endpoints.save'), `fesb-endpoints-${localStamp()}.xlsx`)
    if (!output) return
    setSaving(true)
    setError(null)
    try {
      await saveReport(output, t('nav.api.endpoints'), headers, body)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }, [visible, t])

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  if (rows === null) {
    return (
      <ScreenBody>
        <ErrorBar error={error} />
        <EmptyState
          icon={DownloadSimple}
          title={t('endpoints.empty')}
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
        </EmptyState>
      </ScreenBody>
    )
  }

  return (
    <ScreenBody>
      <div className="flex items-center gap-7 rounded-xl border border-line bg-surface px-5 py-3.5">
        <Readout label={t('endpoints.total')} value={totals.points.toLocaleString()} />
        <Readout label={t('endpoints.in')} value={totals.inbound.toLocaleString()} tone="accent" />
        <Readout label={t('endpoints.systems')} value={totals.systems.toLocaleString()} hint={t('endpoints.systems.hint')} />
        <Readout label={t('endpoints.secured')} value={totals.secured.toLocaleString()} />
        <div className="ml-auto flex items-center gap-2">
          <Button className="min-w-36" disabled={building} onClick={() => void build()}>
            {building ? <><Spinner className="size-4" /> {t('endpoints.building')}</> : t('endpoints.rebuild')}
          </Button>
          <Button variant="primary" className="min-w-52" disabled={saving || visible.length === 0} onClick={() => void exportXlsx()}>
            <ButtonGlyph busy={saving}><DownloadSimple size={14} weight="bold" /></ButtonGlyph>
            {t('endpoints.export', { count: visible.length })}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <SearchInput
          className="flex-1"
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
        <DataTable>
          {/* Адрес — главное в отчёте, ему остаток; шифры уходят на узком окне. */}
          <colgroup>
            <col className="w-44" />
            <col className="w-44" />
            <col className="w-20" />
            <col className="w-24" />
            <col />
            <col className="w-16" />
            <col className="hidden w-20 xl:table-column" />
            <col className="hidden w-32 2xl:table-column" />
          </colgroup>
          <THead>
            <Th>{t('table.domain')}</Th>
            <Th>{t('table.route')}</Th>
            <Th>{t('endpoints.direction')}</Th>
            <Th>{t('endpoints.scheme')}</Th>
            <Th>{t('route.uri')}</Th>
            <Th align="right">{t('endpoints.port')}</Th>
            <Th className="hidden xl:table-cell">{t('endpoints.ssl')}</Th>
            <Th className="hidden 2xl:table-cell">{t('endpoints.protocol')}</Th>
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
                    <td colSpan={8} className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <CaretRight
                          size={11}
                          weight="bold"
                          className={cx('shrink-0 text-content-subtle transition-transform', !collapsed.has(group.key) && 'rotate-90')}
                        />
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
                <td className="truncate px-3 py-1.5" title={row.domain}>{row.domain}</td>
                <td className="px-3 py-1.5">
                  <div className="truncate" title={row.route}>{row.route}</div>
                  <div className="truncate text-[10.5px] text-content-subtle" title={row.component}>{row.component}</div>
                </td>
                <td className="px-3 py-1.5">
                  <Badge tone={row.direction === 'in' ? 'accent' : 'neutral'}>
                    {row.direction === 'in' ? t('endpoints.in') : t('endpoints.out')}
                  </Badge>
                </td>
                <td className="px-3 py-1.5">
                  <CodePill>{row.scheme}</CodePill>
                </td>
                <td className="px-3 py-1.5">
                  <div className="break-all font-mono text-[11px] text-content-muted">{row.uri}</div>
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{row.port ?? '—'}</td>
                <td className="hidden px-3 py-1.5 xl:table-cell">
                  {row.ssl === null
                    ? <span className="text-content-subtle">—</span>
                    : <Badge tone={row.ssl ? 'ok' : 'warn'}>{row.ssl ? t('endpoints.yes') : t('endpoints.no')}</Badge>}
                </td>
                <td className={cx('hidden truncate px-3 py-1.5 font-mono text-[11px] text-content-subtle 2xl:table-cell')}
                  title={row.ciphers ?? ''}>
                  {row.protocol ?? '—'}
                </td>
              </tr>
                ))}
              </Fragment>
            ))}
            {visible.length === 0 && <TableMessage colSpan={8}>{t('endpoints.nothing')}</TableMessage>}
          </tbody>
        </DataTable>
      </Panel>
    </ScreenBody>
  )
}
