import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'

import { Check } from '@phosphor-icons/react'

import { useI18n } from '../i18n'
import { formatBytes } from '../lib/format'
import { folderBesideExport, localStamp } from '../lib/paths'
import {
  apiPush, apiQueueManagers, apiQueues, apiVerify, applyTrace, buildArchive, errorText,
  onApiProgress, onApplyProgress, onArchiveProgress, revealPath, routeLinks, saveZipAs,
} from '../lib/api'
import { neighboursOf } from '../lib/links'
import {
  brokerStats, buildGroups, domainSummary, filterGroups, queueValues,
  selectableKeys, sortGroups, traceModeValues, withoutBroker,
  type DomainGroup, type Filters, type RouteFilter, type SortDir, type SortKey,
} from '../lib/rows'
import type {
  ApiProgress, ApplyProgress, ApplyReport, ApplyTarget, ArchiveProgress, ArchiveResult,
  Connection, LinkGraph, PushResult, QueueManager, ScanResult, ServerInfo, TraceUpdate,
  VerifyResult,
} from '../types'
import { ReportDialog } from './ReportDialog'
import { RouteViewer } from './RouteViewer'
import { TraceTable } from './TraceTable'
import { HeaderActions, ScreenBody, StatsBar } from './ApiShell'
import { Badge, Button, cx, DataTable, FOCUS_RING, Modal, MultiSelect, Notice, SearchInput, Select, Spinner, Stat, SuggestInput, Th, THead, Toggle } from './ui'

interface Props {
  scan: ScanResult
  isMac: boolean
  /** Папка или архив, откуда взята конфигурация — рядом предлагается сохранить zip. */
  sourcePath: string | null
  /** Заполнено, когда конфигурация забрана с сервера: тогда её можно вернуть туда же. */
  server: { server: ServerInfo; connection: Connection } | null
  onRescan: () => Promise<void>
}

/**
 * Единый экран: домены, их СОПС и объекты трассировки с правкой
 * имени брокера, имени очереди и режима трассировки.
 */
export function TraceScreen({ scan, isMac, sourcePath, server, onRescan }: Props) {
  const { t } = useI18n()

  const [filters, setFilters] = useState<Filters>({
    query: '', broker: 'all', onlyEditable: false, onlyChanged: false, routes: 'all',
  })
  const [sortKey, setSortKey] = useState<SortKey>('domain')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const [newBroker, setNewBroker] = useState('')
  const [newQueue, setNewQueue] = useState('')
  const [newTraceMode, setNewTraceMode] = useState('')
  const [makeBackup, setMakeBackup] = useState(true)

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [applying, setApplying] = useState(false)
  const [progress, setProgress] = useState<ApplyProgress | null>(null)
  const [report, setReport] = useState<ApplyReport | null>(null)
  /**
   * Что уже изменено в этой сессии. Ключ не зависит от порядка сканирования,
   * поэтому отметки переживают повторное чтение папки.
   */
  const [changedBeans, setChangedBeans] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const [scopeOpen, setScopeOpen] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [archiveProgress, setArchiveProgress] = useState<ArchiveProgress | null>(null)
  const [archive, setArchive] = useState<ArchiveResult | null>(null)

  /** Одно окно выбора охвата на два действия: отправку и сверку. */
  /** Открытая схема СОПС: путь к файлу и домен, которому он принадлежит. */
  const [route, setRoute] = useState<{ path: string; domain: string } | null>(null)
  /** Граф связей считается один раз на выгрузку — обход всех маршрутов не бесплатный. */
  const [graph, setGraph] = useState<LinkGraph | null>(null)
  const [scopeMode, setScopeMode] = useState<'push' | 'verify' | null>(null)
  const [pushing, setPushing] = useState(false)
  const [pushProgress, setPushProgress] = useState<ApiProgress | null>(null)
  const [pushResult, setPushResult] = useState<PushResult | null>(null)
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null)
  const [reload, setReload] = useState(true)
  const [verifyAfterPush, setVerifyAfterPush] = useState(true)

  /**
   * Что за менеджеры очередей есть на сервере. Пока конфигурация взята из файлов,
   * подсказывать нечем — там известны только значения, уже прописанные в доменах.
   */
  const [managers, setManagers] = useState<QueueManager[]>([])
  const [serverQueues, setServerQueues] = useState<string[]>([])

  const searchRef = useRef<HTMLInputElement>(null)
  const lastClicked = useRef<string | null>(null)

  useEffect(() => {
    const unlisten = onApplyProgress(setProgress)
    return () => { unlisten.then((off) => off()) }
  }, [])

  useEffect(() => {
    const unlisten = onArchiveProgress(setArchiveProgress)
    return () => { unlisten.then((off) => off()) }
  }, [])

  useEffect(() => {
    const unlisten = onApiProgress(setPushProgress)
    return () => { unlisten.then((off) => off()) }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!server) {
      setManagers([])
      return
    }
    let cancelled = false
    apiQueueManagers(server.connection)
      .then((list) => { if (!cancelled) setManagers(list) })
      // Раздел очередей может быть недоступен — подсказки просто останутся файловыми.
      .catch(() => { if (!cancelled) setManagers([]) })
    return () => { cancelled = true }
  }, [server])

  // Новое сканирование приходит с новыми данными — снимаем выделение.
  useEffect(() => { setSelected(new Set()) }, [scan])

  // Связи нужны только при открытии схемы, поэтому считаются при первом открытии.
  useEffect(() => {
    if (!route || graph) return
    let cancelled = false
    routeLinks(scan.root)
      .then((result) => { if (!cancelled) setGraph(result) })
      .catch(() => { if (!cancelled) setGraph({ routes: [], links: [] }) })
    return () => { cancelled = true }
  }, [route, graph, scan.root])

  // Фильтр «только изменённые» бессмыслен, пока изменений нет.
  useEffect(() => {
    if (changedBeans.size === 0) setFilters((prev) => (prev.onlyChanged ? { ...prev, onlyChanged: false } : prev))
  }, [changedBeans])

  const groups = useMemo(() => buildGroups(scan), [scan])
  const stats = useMemo(() => brokerStats(groups), [groups])
  const noBroker = useMemo(() => withoutBroker(groups), [groups])
  /** Два выключателя в виде набора: `MultiSelect` работает с множеством. */
  const extraFilters = useMemo(() => {
    const set = new Set<string>()
    if (filters.onlyEditable) set.add('editable')
    if (filters.onlyChanged) set.add('changed')
    return set
  }, [filters.onlyEditable, filters.onlyChanged])
  const brokerValues = useMemo(() => stats.map((item) => item.value), [stats])
  const queues = useMemo(() => queueValues(groups), [groups])
  const modes = useMemo(() => traceModeValues(groups), [groups])
  const summary = useMemo(() => domainSummary(scan.domains), [scan])
  const visible = useMemo(
    () => sortGroups(filterGroups(groups, filters, changedBeans), sortKey, sortDir),
    [groups, filters, changedBeans, sortKey, sortDir],
  )

  const flatVisible = useMemo(() => visible.flatMap((group) => group.entries), [visible])

  /**
   * Выделение переживает смену фильтров, поэтому часть выбранного может быть
   * не видна. Молчать об этом нельзя: применение затронет и скрытое.
   */
  const hiddenSelected = useMemo(() => {
    const shown = new Set(flatVisible.map((entry) => entry.key))
    return [...selected].filter((key) => !shown.has(key)).length
  }, [flatVisible, selected])
  const selectedEntries = useMemo(
    () => groups.flatMap((group) => group.entries.filter((entry) => selected.has(entry.key)).map((entry) => ({ group, entry }))),
    [groups, selected],
  )

  /** Менеджер, на который сейчас нацелена правка. */
  const targetManager = useMemo(
    () => managers.find((manager) => manager.broker === newBroker.trim()) ?? null,
    [managers, newBroker],
  )

  useEffect(() => {
    if (!server || !targetManager?.running) {
      setServerQueues([])
      return
    }
    let cancelled = false
    apiQueues(server.connection, targetManager.kind, targetManager.id)
      .then((rows) => {
        if (!cancelled) setServerQueues(rows.filter((row) => !row.internal).map((row) => row.name))
      })
      .catch(() => { if (!cancelled) setServerQueues([]) })
    return () => { cancelled = true }
  }, [server, targetManager])

  const update = useMemo<TraceUpdate>(() => ({
    broker: newBroker.trim() || null,
    queue: newQueue.trim() || null,
    traceMode: newTraceMode.trim() || null,
  }), [newBroker, newQueue, newTraceMode])

  const targets = useMemo<ApplyTarget[]>(() => {
    const byFile = new Map<string, ApplyTarget>()
    for (const { group, entry } of selectedEntries) {
      if (!entry.editable) continue
      const bean = {
        beanId: entry.trace.beanId,
        beanName: entry.trace.beanName,
        expectedBroker: entry.trace.broker,
        expectedQueue: entry.trace.queue,
        expectedTraceMode: entry.trace.traceMode,
      }
      const existing = byFile.get(group.domain.domainXmlPath)
      if (existing) existing.beans.push(bean)
      else byFile.set(group.domain.domainXmlPath, {
        domainXmlPath: group.domain.domainXmlPath,
        domainName: group.domain.domainName,
        beans: [bean],
      })
    }
    return [...byFile.values()]
  }, [selectedEntries])

  const valuesToChange = useMemo(() => {
    let count = 0
    for (const { entry } of selectedEntries) {
      if (update.broker && entry.trace.brokerEditable && entry.trace.broker !== update.broker) count++
      if (update.queue && entry.trace.queueEditable && entry.trace.queue !== update.queue) count++
      if (update.traceMode && entry.trace.traceModeEditable && entry.trace.traceMode !== update.traceMode) count++
    }
    return count
  }, [selectedEntries, update])

  // Значения с сервера идут первыми: они точно существуют, в отличие от файловых.
  const brokerOptions = useMemo(
    () => [...new Set([...managers.map((manager) => manager.broker), ...brokerValues])],
    [managers, brokerValues],
  )
  const queueOptions = useMemo(
    () => [...new Set([...serverQueues, ...queues])],
    [serverQueues, queues],
  )
  /** Брокер набран, сервер знает свои менеджеры — и такого среди них нет. */
  const unknownBroker = Boolean(
    update.broker && managers.length > 0 && !managers.some((manager) => manager.broker === update.broker),
  )

  const hasUpdate = update.broker !== null || update.queue !== null || update.traceMode !== null
  const canApply = targets.length > 0 && hasUpdate && !applying

  const toggleEntry = useCallback((key: string, event: MouseEvent) => {
    setSelected((prev) => {
      const next = new Set(prev)
      const lastIndex = lastClicked.current ? flatVisible.findIndex((entry) => entry.key === lastClicked.current) : -1
      const index = flatVisible.findIndex((entry) => entry.key === key)

      // Shift-клик выделяет диапазон от предыдущего клика — привычно по таблицам.
      if (event.shiftKey && lastIndex >= 0 && index >= 0) {
        const [from, to] = [lastIndex, index].sort((a, b) => a - b)
        const shouldSelect = !prev.has(key)
        for (let i = from; i <= to; i++) {
          const entry = flatVisible[i]
          if (!entry.editable) continue
          if (shouldSelect) next.add(entry.key)
          else next.delete(entry.key)
        }
      } else if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
    lastClicked.current = key
  }, [flatVisible])

  const toggleGroup = useCallback((group: DomainGroup) => {
    const keys = group.entries.filter((entry) => entry.editable).map((entry) => entry.key)
    if (keys.length === 0) return
    setSelected((prev) => {
      const next = new Set(prev)
      const allSelected = keys.every((key) => next.has(key))
      for (const key of keys) {
        if (allSelected) next.delete(key)
        else next.add(key)
      }
      return next
    })
    lastClicked.current = keys[keys.length - 1]
  }, [])

  const toggleAll = useCallback(() => {
    const keys = selectableKeys(visible)
    setSelected((prev) => {
      const next = new Set(prev)
      const allSelected = keys.length > 0 && keys.every((key) => next.has(key))
      for (const key of keys) {
        if (allSelected) next.delete(key)
        else next.add(key)
      }
      return next
    })
  }, [visible])

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleSort = useCallback((key: SortKey) => {
    setSortKey((prevKey) => {
      setSortDir((prevDir) => (prevKey === key && prevDir === 'asc' ? 'desc' : 'asc'))
      return key
    })
  }, [])

  const handleApply = useCallback(async () => {
    setConfirmOpen(false)
    setApplying(true)
    setProgress(null)
    setError(null)
    try {
      const result = await applyTrace({ update, targets, makeBackup, dryRun: false })
      setReport(result)
      {
        setChangedBeans((prev) => {
          const next = new Set(prev)
          for (const file of result.results) {
            for (const change of file.changed) {
              if (change.beanId) next.add(`${file.domainXmlPath}::${change.beanId}`)
            }
          }
          return next
        })
        await onRescan()
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setApplying(false)
      setProgress(null)
    }
  }, [update, targets, makeBackup, onRescan])

  /** Папки доменов, в которых что-то изменено в этой сессии. */
  const changedDomains = useMemo(() => {
    const paths = new Set<string>()
    for (const group of groups) {
      const touched = group.entries.some((entry) =>
        entry.trace.beanId && changedBeans.has(`${group.domain.domainXmlPath}::${entry.trace.beanId}`))
      if (touched) paths.add(group.domain.dirPath)
    }
    return [...paths]
  }, [groups, changedBeans])

  /** Папки доменов, в которых есть хотя бы один выбранный объект трассировки. */
  const selectedDomains = useMemo(() => {
    const paths = new Set<string>()
    for (const { group } of selectedEntries) paths.add(group.domain.dirPath)
    return [...paths]
  }, [selectedEntries])

  /** Идентификаторы доменов для отправки: имя папки в выгрузке и есть guid. */
  const guidsOf = useCallback((paths: string[]) => {
    const wanted = new Set(paths)
    return groups
      .filter((group) => wanted.has(group.domain.dirPath))
      .map((group) => group.domain.dirName)
  }, [groups])

  const scopeGuids = useCallback(
    (paths: string[] | null) => (paths === null ? groups.map((group) => group.domain.dirName) : guidsOf(paths)),
    [groups, guidsOf],
  )

  const pushToServer = useCallback(async (paths: string[] | null) => {
    if (!server) return
    setScopeMode(null)
    const guids = scopeGuids(paths)
    if (guids.length === 0) return

    setPushing(true)
    setPushProgress(null)
    setError(null)
    setVerifyResult(null)
    try {
      setPushResult(await apiPush(server.connection, scan.root, guids, reload))
      // Отправка отвечает 200 и тогда, когда шина сохранила не всё:
      // единственный честный ответ — прочитать конфигурацию обратно.
      if (verifyAfterPush) setVerifyResult(await apiVerify(server.connection, scan.root, guids))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setPushing(false)
      setPushProgress(null)
    }
  }, [server, scopeGuids, scan.root, reload, verifyAfterPush])

  /** Сверка без отправки: показать, чем сервер отличается от локальных файлов. */
  const verifyOnServer = useCallback(async (paths: string[] | null) => {
    if (!server) return
    setScopeMode(null)
    const guids = scopeGuids(paths)
    if (guids.length === 0) return

    setPushing(true)
    setPushProgress(null)
    setError(null)
    setPushResult(null)
    try {
      setVerifyResult(await apiVerify(server.connection, scan.root, guids))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setPushing(false)
      setPushProgress(null)
    }
  }, [server, scopeGuids, scan.root])

  /** Собирает архив в структуре исходной выгрузки — его можно залить обратно в шину. */
  const buildZip = useCallback(async (domains: string[] | null) => {
    setScopeOpen(false)
    // Кладём рядом с папкой конфигурации, а не внутрь неё: иначе архив попадёт в следующий архив.
    const suggested = `${folderBesideExport(sourcePath ?? scan.root)}config-${localStamp()}.zip`
    const output = await saveZipAs(t('dialog.saveZip'), suggested)
    if (!output) return

    setArchiving(true)
    setArchiveProgress(null)
    setError(null)
    try {
      setArchive(await buildArchive(scan.root, output, domains))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setArchiving(false)
      setArchiveProgress(null)
    }
  }, [scan.root, sourcePath, t])

  // Спрашиваем про охват, когда есть из чего выбирать: выделение или правки сессии.
  const startBuild = useCallback(() => {
    if (selectedDomains.length > 0 || changedDomains.length > 0) setScopeOpen(true)
    else void buildZip(null)
  }, [buildZip, selectedDomains.length, changedDomains.length])

  const shortcut = isMac ? '⌘' : 'Ctrl'

  return (
    <ScreenBody>
      <StatsBar>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-7 gap-y-3">
        <Stat label={t('stats.domains')} value={summary.domains} />
        <Stat label={t('stats.traceBeans')} value={summary.traces} />
        <Stat label={t('stats.withBroker')} value={summary.withBroker} tone="accent" hint={t('stats.withBroker.hint')} />
        <Stat label={t('stats.routes')} value={summary.routes} />
        <Stat label={t('stats.tracedRoutes')} value={summary.tracedRoutes} tone="accent" />
        <Stat
          label={t('routes.filter.untraced')}
          value={summary.routes - summary.tracedRoutes}
          tone={summary.routes > summary.tracedRoutes ? 'warn' : undefined}
        />
        {/* Их всегда единицы, и найти их иначе можно только руками:
            в таблице они подписаны словами, а не именем объекта. */}
        {summary.defaultTraced > 0 && (
          <Stat
            label={t('stats.defaultTraced')}
            value={summary.defaultTraced}
            tone="warn"
            hint={t('stats.defaultTraced.hint')}
          />
        )}
        {summary.withErrors > 0 && <Stat label={t('stats.readErrors')} value={summary.withErrors} tone="danger" />}
        </div>

      </StatsBar>

      <SearchInput
        inputRef={searchRef}
        value={filters.query}
        onChange={(query) => setFilters((prev) => ({ ...prev, query }))}
        placeholder={t('search.placeholder', { shortcut })}
        clearLabel={t('action.clearSearch')}
      />

      {/* Фильтры слева, счётчики справа: появление «выбрано» не двигает ни то,
          ни другое. На узком окне строка переносится, а не уезжает за край. */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Два вопроса к СОПС домена взаимоисключающие, поэтому это выбор,
            а не два выключателя: строка фильтров и так близка к краю. */}
        <Select<RouteFilter>
          ariaLabel={t('filter.routes')}
          label={t('filter.routes')}
          className="w-60"
          value={filters.routes}
          onChange={(value) => setFilters((prev) => ({ ...prev, routes: value }))}
          options={[
            { id: 'all', label: t('filter.all') },
            { id: 'untraced', label: t('filter.untracedRoutes') },
            { id: 'default', label: t('filter.defaultTraced') },
          ]}
        />
        {/* Фильтр по брокеру — такой же пикёр, как соседние: значений
            бывает под десяток, и полоса фишек уезжала за край окна. */}
        <Select<string>
          ariaLabel={t('table.broker')}
          label={t('table.broker')}
          className="w-64"
          value={filters.broker}
          onChange={(value) => setFilters((prev) => ({ ...prev, broker: value }))}
          options={[
            { id: 'all', label: t('filter.all') },
            ...(noBroker > 0 ? [{ id: 'none', label: t('filter.noBroker'), hint: String(noBroker) }] : []),
            ...stats.map((item) => ({ id: item.value, label: item.value, hint: String(item.count) })),
          ]}
        />

        {/* Два редких отбора убраны с глаз в свой блок: рядом с брокером
            и доменами они читались как равные, а спрашивают их куда реже. */}
        <MultiSelect
          label={t('filter.additional')}
          emptyLabel={t('filter.additional.none')}
          className="w-56"
          options={[
            { id: 'editable', label: t('filter.onlyEditable') },
            // Изменённых ещё нет — и отбирать нечего.
            ...(changedBeans.size > 0 ? [{ id: 'changed', label: t('filter.onlyChanged') }] : []),
          ]}
          selected={extraFilters}
          onChange={(next) => setFilters((prev) => ({
            ...prev,
            onlyEditable: next.has('editable'),
            onlyChanged: next.has('changed'),
          }))}
        />

        <div className="ml-auto flex items-center gap-2 text-[11.5px] text-content-subtle">
          <span>{t('filter.shown', { visible: visible.length, total: groups.length })}</span>
          {selectedEntries.length > 0 && (
            <>
              <Badge
                tone="accent"
                title={t('filter.selectedHint', { count: selectedEntries.length, domains: selectedDomains.length })}
              >
                {t('filter.selected', { count: selectedEntries.length })}
              </Badge>
              {hiddenSelected > 0 && (
                <Badge tone="warn" title={t('filter.selectedHiddenHint')}>
                  {t('filter.selectedHidden', { count: hiddenSelected })}
                </Badge>
              )}
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>{t('action.deselect')}</Button>
            </>
          )}
        </div>
      </div>

      {/* Сборка архива стоит в шапке рядом с «Open ZIP»: там же, где
          открывают чужой архив, собирают и свой. */}
      <HeaderActions>
        <Button onClick={startBuild} disabled={archiving}>
          {archiving
            ? <><Spinner className="size-3.5" /> {archiveProgress ? `${archiveProgress.current} / ${archiveProgress.total}` : t('zip.building')}</>
            : t('action.buildZip')}
        </Button>
      </HeaderActions>

      {error && <Notice tone="danger">{error}</Notice>}

      <TraceTable
        groups={visible}
        routeFilter={filters.routes}
        selected={selected}
        changedBeans={changedBeans}
        expanded={expanded}
        sortKey={sortKey}
        sortDir={sortDir}
        update={update}
        onToggleEntry={toggleEntry}
        onToggleGroup={toggleGroup}
        onToggleAll={toggleAll}
        onToggleExpand={toggleExpand}
        onSort={handleSort}
        onReveal={revealPath}
        onOpenRoute={(path, domain) => setRoute({ path, domain })}
      />

      <div className="rounded-xl border border-line bg-surface">
        <div className="flex items-end gap-4 px-5 pt-4">
          <Field label={t('apply.newBroker')} htmlFor="broker-input">
            <SuggestInput
              id="broker-input"
              value={newBroker}
              options={brokerOptions}
              placeholder={t('apply.brokerPlaceholder')}
              emptyLabel={t('apply.noSuggestions')}
              onChange={setNewBroker}
            />
          </Field>

          <Field label={t('apply.newQueue')} htmlFor="queue-input">
            <SuggestInput
              id="queue-input"
              value={newQueue}
              options={queueOptions}
              placeholder={t('apply.queuePlaceholder')}
              emptyLabel={t('apply.noSuggestions')}
              onChange={setNewQueue}
            />
          </Field>

          <Field label={t('apply.newTraceMode')} htmlFor="mode-input">
            <SuggestInput
              id="mode-input"
              value={newTraceMode}
              options={modes}
              placeholder={t('apply.traceModePlaceholder')}
              emptyLabel={t('apply.noSuggestions')}
              onChange={setNewTraceMode}
            />
          </Field>

        </div>

        <p className="px-5 pt-1.5 text-[11.5px] text-content-subtle">{t('apply.hint')}</p>
        {update.broker && !update.broker.includes(':') && (
          <p className="px-5 pt-1 text-[11.5px] text-caution">{t('apply.brokerWarning')}</p>
        )}
        {unknownBroker && (
          <p className="px-5 pt-1 text-[11.5px] text-caution">{t('apply.unknownBroker')}</p>
        )}
        {targetManager && !targetManager.running && (
          <p className="px-5 pt-1 text-[11.5px] text-content-subtle">
            {t('apply.managerStopped', { broker: targetManager.broker })}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line px-5 py-3">
          {/* Обмен с сервером — слева, у нижнего края: правки готовят здесь же,
              и отсюда же их отдают. Общая рамка говорит, что это две стороны
              одного дела: сначала сравнить, потом отправить. */}
          {server && (
            <div className="flex items-stretch overflow-hidden rounded-lg border border-line-strong bg-surface-2">
              <button
                type="button"
                onClick={() => setScopeMode('verify')}
                disabled={pushing}
                className={cx(
                  'inline-flex h-9 items-center gap-2 px-3.5 text-[13px] font-medium transition',
                  'hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-40',
                  FOCUS_RING,
                )}
              >
                {t('action.verify')}
              </button>
              <button
                type="button"
                onClick={() => setScopeMode('push')}
                disabled={pushing}
                className={cx(
                  'inline-flex h-9 items-center gap-2 border-l border-line-strong px-3.5 text-[13px] font-medium transition',
                  'hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-40',
                  FOCUS_RING,
                )}
              >
                {pushing
                  ? <><Spinner className="size-3.5" /> {t(pushPhase(pushProgress?.phase))}</>
                  : t('action.push')}
              </button>
            </div>
          )}

          <div className="ml-auto flex items-center gap-3">
            <span className="text-[11.5px] text-content-subtle">
              {selectedEntries.length === 0
                ? t('apply.selectPrompt')
                : t('apply.selection', { beans: selectedEntries.length, files: targets.length, values: valuesToChange })}
            </span>
            {/* Резервная копия стоит рядом с «Применить», потому что это условие
                применения, а не отдельная настройка: зелёная — копия будет. */}
            <button
              type="button"
              onClick={() => setMakeBackup(!makeBackup)}
              title={t('apply.backup.hint')}
              aria-pressed={makeBackup}
              className={cx(
                'inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-[12.5px] font-medium transition',
                FOCUS_RING,
                makeBackup
                  ? 'border-positive/45 bg-positive/12 text-positive hover:bg-positive/20'
                  : 'border-line-strong bg-surface-2 text-content-muted hover:bg-surface-3',
              )}
            >
              <span
                className={cx(
                  'grid size-4 place-items-center rounded border transition',
                  makeBackup ? 'border-positive/60 bg-positive/25' : 'border-line-strong',
                )}
              >
                {makeBackup && <Check size={11} weight="bold" />}
              </span>
              {t('apply.backup')}
            </button>
            <Button variant="primary" onClick={() => setConfirmOpen(true)} disabled={!canApply}>
              {applying
                ? <><Spinner className="size-4" /> {progress ? `${progress.current} / ${progress.total}` : t('empty.scanning')}</>
                : t('action.apply')}
            </Button>
          </div>
        </div>
      </div>

      <RouteViewer
        path={route?.path ?? null}
        domainName={route?.domain ?? null}
        isMac={isMac}
        live={null}
        links={neighboursOf(graph, route?.path ?? null)}
        onOpenRoute={(path) => {
          const target = graph?.routes.find((item) => item.path === path)
          setRoute({ path, domain: target?.domain ?? route?.domain ?? '' })
        }}
        onClose={() => setRoute(null)}
      />

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        closeLabel={t('action.close')}
        title={t('confirm.title')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>{t('action.cancel')}</Button>
            <Button variant="primary" onClick={handleApply}>{t('confirm.submit')}</Button>
          </>
        }
      >
        <div className="space-y-3 text-[13px] leading-relaxed">
          <div className="flex flex-col gap-1">
            {update.broker && <ConfirmValue text={t('confirm.broker', { value: update.broker })} />}
            {update.queue && <ConfirmValue text={t('confirm.queue', { value: update.queue })} />}
            {update.traceMode && <ConfirmValue text={t('confirm.traceMode', { value: update.traceMode })} />}
          </div>
          <ul className="list-disc space-y-1 pl-4 text-content-muted marker:text-content-subtle">
            <li>{t('confirm.domains', { count: targets.length })}</li>
            <li>{t('confirm.beans', { count: selectedEntries.length })}</li>
            <li>{t('confirm.values', { count: valuesToChange })}</li>
          </ul>
          <Notice tone={makeBackup ? 'ok' : 'warn'}>
            {makeBackup ? t('confirm.backupOn') : t('confirm.backupOff')}
          </Notice>
        </div>
      </Modal>

      <ReportDialog
        report={report}
        scan={scan}
        archiving={archiving}
        onBuildArchive={startBuild}
        onClose={() => setReport(null)}
      />

      <Modal
        open={scopeOpen}
        onClose={() => setScopeOpen(false)}
        closeLabel={t('action.close')}
        title={t('zip.scope.title')}
        footer={<Button variant="ghost" onClick={() => setScopeOpen(false)}>{t('action.cancel')}</Button>}
      >
        <div className="space-y-2">
          {changedDomains.length > 0 && (
            <Button variant="primary" className="w-full justify-start" onClick={() => buildZip(changedDomains)}>
              {t('zip.scope.changed', { count: changedDomains.length })}
            </Button>
          )}
          {selectedDomains.length > 0 && (
            <Button
              variant={changedDomains.length > 0 ? 'secondary' : 'primary'}
              className="w-full justify-start"
              onClick={() => buildZip(selectedDomains)}
            >
              {t('zip.scope.selected', { count: selectedDomains.length })}
            </Button>
          )}
          <Button className="w-full justify-start" onClick={() => buildZip(null)}>
            {t('zip.scope.all', { count: scan.domains.length })}
          </Button>
          <p className="pt-1 text-[11.5px] text-content-subtle">{t('zip.scope.hint')}</p>
        </div>
      </Modal>

      <Modal
        open={scopeMode !== null}
        onClose={() => setScopeMode(null)}
        closeLabel={t('action.close')}
        title={scopeMode === 'verify' ? t('verify.scope.title') : t('push.scope.title')}
        footer={<Button variant="ghost" onClick={() => setScopeMode(null)}>{t('action.cancel')}</Button>}
      >
        <div className="space-y-2">
          {(() => {
            const run = scopeMode === 'verify' ? verifyOnServer : pushToServer
            return (
              <>
                {changedDomains.length > 0 && (
                  <Button variant="primary" className="w-full justify-start" onClick={() => void run(changedDomains)}>
                    {t('zip.scope.changed', { count: changedDomains.length })}
                  </Button>
                )}
                {selectedDomains.length > 0 && (
                  <Button
                    variant={changedDomains.length > 0 ? 'secondary' : 'primary'}
                    className="w-full justify-start"
                    onClick={() => void run(selectedDomains)}
                  >
                    {t('zip.scope.selected', { count: selectedDomains.length })}
                  </Button>
                )}
                <Button className="w-full justify-start" onClick={() => void run(null)}>
                  {t('zip.scope.all', { count: scan.domains.length })}
                </Button>
              </>
            )
          })()}
          {scopeMode === 'push' && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Toggle checked={reload} onChange={setReload} label={t('push.reload')} />
              <Toggle checked={verifyAfterPush} onChange={setVerifyAfterPush} label={t('push.verify')} />
            </div>
          )}
          <p className="text-[11.5px] leading-relaxed text-content-subtle">
            {scopeMode === 'verify' ? t('verify.scope.hint') : t('push.scope.hint')}
          </p>
        </div>
      </Modal>

      <Modal
        width="wide"
        open={pushResult !== null || verifyResult !== null}
        onClose={() => { setPushResult(null); setVerifyResult(null) }}
        closeLabel={t('action.close')}
        title={pushResult ? t('push.title') : t('verify.title')}
        footer={
          <Button variant="primary" onClick={() => { setPushResult(null); setVerifyResult(null) }}>
            {t('action.close')}
          </Button>
        }
      >
        {pushResult && (
          <div className="space-y-3 text-[13px] leading-relaxed">
            <div className="flex flex-wrap gap-8">
              <Stat label={t('zip.domains')} value={pushResult.domains.length} tone="accent" />
              <Stat label={t('zip.files')} value={pushResult.files} />
              <Stat label={t('zip.size')} value={formatBytes(pushResult.bytes)} />
            </div>
            <div className="max-h-40 overflow-y-auto rounded-lg border border-line bg-surface-2 px-3 py-2">
              {pushResult.domains.map((name) => (
                <div key={name} className="truncate text-[12.5px] text-content-muted">{name}</div>
              ))}
            </div>
            {pushResult.message && (
              <p className="rounded-lg border border-line px-3 py-2 text-content-muted">{pushResult.message}</p>
            )}
            <Notice tone={pushResult.reloaded ? 'ok' : 'warn'}>
              {pushResult.reloaded ? t('push.reloadedOn') : t('push.reloadedOff')}
            </Notice>
          </div>
        )}

        {verifyResult && <VerifyReport result={verifyResult} />}
      </Modal>

      <Modal
        open={archive !== null}
        onClose={() => setArchive(null)}
        closeLabel={t('action.close')}
        title={t('zip.title')}
        footer={
          <>
            {archive && (
              <Button variant="ghost" onClick={() => revealPath(archive.path)}>{t('action.reveal')}</Button>
            )}
            <Button variant="primary" onClick={() => setArchive(null)}>{t('action.close')}</Button>
          </>
        }
      >
        {archive && (
          <div className="space-y-3 text-[13px] leading-relaxed">
            <code className="block break-all rounded bg-surface-2 px-2 py-1.5 font-mono text-[11.5px] text-content-muted">
              {archive.path}
            </code>
            <div className="flex flex-wrap gap-8">
              <Stat label={t('zip.domains')} value={archive.domains} tone="accent" />
              <Stat label={t('zip.files')} value={archive.files} />
              <Stat label={t('zip.size')} value={formatBytes(archive.bytes)} />
              {archive.skippedBackups > 0 && <Stat label={t('zip.skippedBackups')} value={archive.skippedBackups} />}
            </div>
            <p className="text-content-muted">{t('zip.hint')}</p>
            {!archive.hasVersion && (
              <Notice tone="warn">{t('zip.noVersion')}</Notice>
            )}
          </div>
        )}
      </Modal>
    </ScreenBody>
  )
}

/** Что показывать на кнопке отправки: фаза приходит из бэкенда. */
function pushPhase(phase: ApiProgress['phase'] | undefined): 'push.running' | 'push.uploading' | 'push.verifying' {
  if (phase === 'upload') return 'push.uploading'
  if (phase === 'verify') return 'push.verifying'
  return 'push.running'
}

/** Что сервер отдаёт обратно и чем это отличается от локальных файлов. */
function VerifyReport({ result }: { result: VerifyResult }) {
  const { t } = useI18n()
  const clean = result.mismatches.length === 0

  return (
    <div className="mt-4 space-y-3 border-t border-line pt-4 text-[13px] leading-relaxed">
      <div className="flex flex-wrap gap-8">
        <Stat label={t('verify.domains')} value={result.domains} />
        <Stat label={t('verify.values')} value={result.values} tone={clean ? 'accent' : undefined} />
        <Stat
          label={t('verify.mismatches')}
          value={result.mismatches.length}
          tone={clean ? undefined : 'danger'}
        />
      </div>

      {clean ? (
        <Notice tone="ok">
          {t('verify.clean', { count: result.values })}
        </Notice>
      ) : (
        <>
          <Notice tone="danger">
            {t('verify.dirty', { count: result.mismatches.length })}
          </Notice>
          <div className="max-h-64 overflow-auto rounded-lg border border-line">
            <DataTable>
              <colgroup>
                <col />
                <col className="w-32" />
                <col className="w-20" />
                <col className="w-40" />
                <col className="w-40" />
              </colgroup>
              <THead>
                  <Th className="px-2 py-1.5">{t('table.domain')}</Th>
                  <Th className="px-2 py-1.5">{t('table.traceBean')}</Th>
                  <Th className="px-2 py-1.5">{t('verify.field')}</Th>
                  <Th className="px-2 py-1.5">{t('verify.expected')}</Th>
                  <Th className="px-2 py-1.5">{t('verify.actual')}</Th>
              </THead>
              <tbody>
                {result.mismatches.map((item, index) => (
                  <tr key={`${item.domain}-${item.bean}-${item.field}-${index}`} className="border-b border-line/60">
                    <td className="truncate px-2 py-1.5" title={item.domain}>{item.domain}</td>
                    <td className="truncate px-2 py-1.5 font-mono text-[11px]" title={item.bean ?? ''}>
                      {item.bean ?? '—'}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-[11px]">{item.field}</td>
                    <td className="truncate px-2 py-1.5 font-mono text-[11px] text-accent-content" title={item.expected ?? ''}>
                      {item.field === 'bean' ? t('verify.beanMissing') : item.expected ?? '—'}
                    </td>
                    <td className="truncate px-2 py-1.5 font-mono text-[11px] text-negative" title={item.actual ?? ''}>
                      {item.actual ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        </>
      )}
    </div>
  )
}

/** Метка времени в локальном часовом поясе: `2026-08-25-0112`. */

function ConfirmValue({ text }: { text: string }) {
  return <code className="rounded bg-accent/12 px-2 py-1 font-mono text-accent-content">{text}</code>
}

function Field({ label, htmlFor, className, children }: {
  label: string
  htmlFor: string
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cx('min-w-44 flex-1', className)}>
      <label className="mb-1.5 block text-[11px] tracking-wide text-content-subtle" htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  )
}
