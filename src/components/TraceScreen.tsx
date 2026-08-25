import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'

import { useI18n } from '../i18n'
import {
  apiPush, applyTrace, buildArchive, errorText, onApiProgress, onApplyProgress, onArchiveProgress,
  revealPath, saveZipAs,
} from '../lib/api'
import {
  brokerStats, buildGroups, domainSummary, filterGroups, queueValues,
  selectableKeys, sortGroups, traceModeValues,
  type DomainGroup, type Filters, type SortDir, type SortKey,
} from '../lib/rows'
import type {
  ApiProgress, ApplyProgress, ApplyReport, ApplyTarget, ArchiveProgress, ArchiveResult,
  Connection, PushResult, ScanResult, ServerInfo, TraceUpdate,
} from '../types'
import { ReportDialog } from './ReportDialog'
import { TraceTable } from './TraceTable'
import { Badge, Button, Checkbox, Modal, ScrollStrip, Spinner, Stat, SuggestInput, TextInput, cx } from './ui'

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
    query: '', broker: 'all', onlyEditable: false, onlyChanged: false, untracedRoutes: false,
  })
  const [sortKey, setSortKey] = useState<SortKey>('domain')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const [newBroker, setNewBroker] = useState('')
  const [newQueue, setNewQueue] = useState('')
  const [newTraceMode, setNewTraceMode] = useState('')
  const [makeBackup, setMakeBackup] = useState(true)
  const [dryRun, setDryRun] = useState(false)

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

  const [pushOpen, setPushOpen] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [pushProgress, setPushProgress] = useState<ApiProgress | null>(null)
  const [pushResult, setPushResult] = useState<PushResult | null>(null)
  const [reload, setReload] = useState(true)

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

  // Новое сканирование приходит с новыми данными — снимаем выделение.
  useEffect(() => { setSelected(new Set()) }, [scan])

  // Фильтр «только изменённые» бессмыслен, пока изменений нет.
  useEffect(() => {
    if (changedBeans.size === 0) setFilters((prev) => (prev.onlyChanged ? { ...prev, onlyChanged: false } : prev))
  }, [changedBeans])

  const groups = useMemo(() => buildGroups(scan), [scan])
  const stats = useMemo(() => brokerStats(groups), [groups])
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

  const selectByBroker = useCallback((value: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const group of groups) {
        for (const entry of group.entries) {
          if (entry.editable && entry.trace.broker === value) next.add(entry.key)
        }
      }
      return next
    })
  }, [groups])

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
      const result = await applyTrace({ update, targets, makeBackup, dryRun })
      setReport(result)
      if (!dryRun) {
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
  }, [update, targets, makeBackup, dryRun, onRescan])

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

  const pushToServer = useCallback(async (paths: string[] | null) => {
    if (!server) return
    setPushOpen(false)
    const guids = paths === null ? groups.map((group) => group.domain.dirName) : guidsOf(paths)
    if (guids.length === 0) return

    setPushing(true)
    setPushProgress(null)
    setError(null)
    try {
      setPushResult(await apiPush(server.connection, scan.root, guids, reload))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setPushing(false)
      setPushProgress(null)
    }
  }, [server, groups, guidsOf, scan.root, reload])

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
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-4">
      <div className="flex items-center gap-7 rounded-xl border border-line bg-surface px-5 py-3.5">
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
        {summary.withErrors > 0 && <Stat label={t('stats.readErrors')} value={summary.withErrors} tone="danger" />}

        {/* Значений брокера может быть много: строка не растёт вниз, а прокручивается. */}
        <ScrollStrip
          className="ml-auto"
          itemCount={stats.length}
          scrollLeftLabel={t('action.scrollLeft')}
          scrollRightLabel={t('action.scrollRight')}
        >
          <FilterChip active={filters.broker === 'all'} onClick={() => setFilters((prev) => ({ ...prev, broker: 'all' }))}>
            {t('filter.all')}
          </FilterChip>
          {stats.map((item) => (
            <FilterChip
              key={item.value}
              mono
              active={filters.broker === item.value}
              title={t('filter.chipHint')}
              onClick={() => setFilters((prev) => ({ ...prev, broker: prev.broker === item.value ? 'all' : item.value }))}
              onDoubleClick={() => selectByBroker(item.value)}
            >
              <span className="whitespace-nowrap">{item.value}</span>
              <span className="rounded bg-surface-3 px-1 text-[10px] tabular-nums">{item.count}</span>
            </FilterChip>
          ))}
        </ScrollStrip>
      </div>

      <div className="relative">
        <TextInput
          ref={searchRef}
          value={filters.query}
          onChange={(event) => setFilters((prev) => ({ ...prev, query: event.target.value }))}
          placeholder={t('search.placeholder', { shortcut })}
          className="pl-8"
        />
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle">⌕</span>
        {filters.query && (
          <button
            type="button"
            aria-label={t('action.clearSearch')}
            onClick={() => setFilters((prev) => ({ ...prev, query: '' }))}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1 text-content-subtle hover:text-content"
          >
            ✕
          </button>
        )}
      </div>

      {/* Фильтры слева, счётчики справа: появление «выбрано» не двигает ни то, ни другое. */}
      <div className="flex items-center gap-2">
        <Toggle
          checked={filters.onlyEditable}
          onChange={(value) => setFilters((prev) => ({ ...prev, onlyEditable: value }))}
          label={t('filter.onlyEditable')}
        />
        <Toggle
          checked={filters.onlyChanged}
          onChange={(value) => setFilters((prev) => ({ ...prev, onlyChanged: value }))}
          label={t('filter.onlyChanged')}
          disabled={changedBeans.size === 0}
          title={changedBeans.size === 0 ? t('filter.onlyChangedHint') : undefined}
        />
        <Toggle
          checked={filters.untracedRoutes}
          onChange={(value) => setFilters((prev) => ({ ...prev, untracedRoutes: value }))}
          label={t('filter.untracedRoutes')}
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
          {server && (
            <Button size="sm" variant="primary" onClick={() => setPushOpen(true)} disabled={pushing}>
              {pushing
                ? <><Spinner className="size-3.5" /> {pushProgress?.phase === 'upload' ? t('push.uploading') : t('push.running')}</>
                : t('action.push')}
            </Button>
          )}
          <Button size="sm" onClick={startBuild} disabled={archiving}>
            {archiving
              ? <><Spinner className="size-3.5" /> {archiveProgress ? `${archiveProgress.current} / ${archiveProgress.total}` : t('zip.building')}</>
              : t('action.buildZip')}
          </Button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-negative">{error}</div>}

      <TraceTable
        groups={visible}
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
      />

      <div className="rounded-xl border border-line bg-surface">
        <div className="flex items-end gap-4 px-5 pt-4">
          <Field label={t('apply.newBroker')} htmlFor="broker-input">
            <SuggestInput
              id="broker-input"
              value={newBroker}
              options={brokerValues}
              placeholder={t('apply.brokerPlaceholder')}
              emptyLabel={t('apply.noSuggestions')}
              onChange={setNewBroker}
            />
          </Field>

          <Field label={t('apply.newQueue')} htmlFor="queue-input">
            <SuggestInput
              id="queue-input"
              value={newQueue}
              options={queues}
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

        <div className="mt-3 flex items-center gap-2 border-t border-line px-5 py-3">
          <Toggle checked={makeBackup} onChange={setMakeBackup} label={t('apply.backup')} />
          <Toggle checked={dryRun} onChange={setDryRun} label={t('apply.dryRun')} />

          <div className="ml-auto flex items-center gap-3">
            <span className="text-[11.5px] text-content-subtle">
              {selectedEntries.length === 0
                ? t('apply.selectPrompt')
                : t('apply.selection', { beans: selectedEntries.length, files: targets.length, values: valuesToChange })}
            </span>
            <Button variant="primary" onClick={() => setConfirmOpen(true)} disabled={!canApply}>
              {applying
                ? <><Spinner className="size-4" /> {progress ? `${progress.current} / ${progress.total}` : t('empty.scanning')}</>
                : dryRun ? t('action.check') : t('action.apply')}
            </Button>
          </div>
        </div>
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        closeLabel={t('action.close')}
        title={dryRun ? t('confirm.titleDry') : t('confirm.title')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>{t('action.cancel')}</Button>
            <Button variant={dryRun ? 'secondary' : 'primary'} onClick={handleApply}>
              {dryRun ? t('confirm.submitDry') : t('confirm.submit')}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[13px] leading-relaxed">
          <div className="flex flex-col gap-1">
            {update.broker && <ConfirmValue text={t('confirm.broker', { value: update.broker })} />}
            {update.queue && <ConfirmValue text={t('confirm.queue', { value: update.queue })} />}
            {update.traceMode && <ConfirmValue text={t('confirm.traceMode', { value: update.traceMode })} />}
          </div>
          <ul className="space-y-1 text-content-muted">
            <li>· {t('confirm.domains', { count: targets.length })}</li>
            <li>· {t('confirm.beans', { count: selectedEntries.length })}</li>
            <li>· {t('confirm.values', { count: valuesToChange })}</li>
          </ul>
          <p className={cx('rounded-lg border px-3 py-2',
            makeBackup ? 'border-positive/35 bg-positive/10 text-positive' : 'border-caution/35 bg-caution/10 text-caution')}>
            {makeBackup ? t('confirm.backupOn') : t('confirm.backupOff')}
          </p>
          {dryRun && <p className="text-content-muted">{t('confirm.dryRunNote')}</p>}
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
        open={pushOpen}
        onClose={() => setPushOpen(false)}
        closeLabel={t('action.close')}
        title={t('push.scope.title')}
        footer={<Button variant="ghost" onClick={() => setPushOpen(false)}>{t('action.cancel')}</Button>}
      >
        <div className="space-y-2">
          {changedDomains.length > 0 && (
            <Button variant="primary" className="w-full justify-start" onClick={() => void pushToServer(changedDomains)}>
              {t('zip.scope.changed', { count: changedDomains.length })}
            </Button>
          )}
          {selectedDomains.length > 0 && (
            <Button
              variant={changedDomains.length > 0 ? 'secondary' : 'primary'}
              className="w-full justify-start"
              onClick={() => void pushToServer(selectedDomains)}
            >
              {t('zip.scope.selected', { count: selectedDomains.length })}
            </Button>
          )}
          <Button className="w-full justify-start" onClick={() => void pushToServer(null)}>
            {t('zip.scope.all', { count: scan.domains.length })}
          </Button>
          <div className="pt-1">
            <Toggle checked={reload} onChange={setReload} label={t('push.reload')} />
          </div>
          <p className="text-[11.5px] leading-relaxed text-content-subtle">{t('push.scope.hint')}</p>
        </div>
      </Modal>

      <Modal
        open={pushResult !== null}
        onClose={() => setPushResult(null)}
        closeLabel={t('action.close')}
        title={t('push.title')}
        footer={<Button variant="primary" onClick={() => setPushResult(null)}>{t('action.close')}</Button>}
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
            <p className={cx('rounded-lg border px-3 py-2',
              pushResult.reloaded
                ? 'border-positive/35 bg-positive/10 text-positive'
                : 'border-caution/35 bg-caution/10 text-caution')}>
              {pushResult.reloaded ? t('push.reloadedOn') : t('push.reloadedOff')}
            </p>
          </div>
        )}
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
              <p className="rounded-lg border border-caution/35 bg-caution/10 px-3 py-2 text-caution">{t('zip.noVersion')}</p>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

/** Метка времени в локальном часовом поясе: `2026-08-25-0112`. */
function localStamp(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

/**
 * Папка, в которую логично положить новый архив: рядом с исходной выгрузкой.
 * Для `…/config-X/domains` это `…/`, для `…/config-X.zip` — тоже `…/`.
 */
function folderBesideExport(source: string): string {
  const separator = source.includes('\\') && !source.includes('/') ? '\\' : '/'
  const parts = source.split(/[/\\]/).filter(Boolean)
  const last = parts[parts.length - 1] ?? ''
  // Файл архива и папка конфигурации лежат на одном уровне, папка domains — на уровень глубже.
  const up = last === 'domains' ? 2 : 1
  const kept = parts.slice(0, Math.max(parts.length - up, 0))
  const prefix = source.startsWith('/') ? '/' : ''
  return kept.length > 0 ? `${prefix}${kept.join(separator)}${separator}` : prefix
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

function Toggle({ checked, onChange, label, disabled, title }: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  disabled?: boolean
  title?: string
}) {
  return (
    <label
      title={title}
      className={cx(
        'flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 text-content-muted',
        disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
      )}
    >
      <Checkbox checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  )
}

function FilterChip({ active, mono, children, ...rest }: {
  active: boolean
  mono?: boolean
  children: ReactNode
} & React.ComponentProps<'button'>) {
  return (
    <button
      type="button"
      className={cx(
        'flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-[11.5px] transition',
        mono && 'font-mono',
        active ? 'border-accent/50 bg-accent/12 text-accent-content' : 'border-line-strong text-content-muted hover:bg-surface-3',
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
