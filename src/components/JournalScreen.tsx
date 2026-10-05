import { useCallback, useEffect, useMemo, useState } from 'react'

import { ArrowCounterClockwise, CaretDown, CaretRight, ClockCounterClockwise } from '@phosphor-icons/react'

import { formatNumber, useI18n } from '../i18n'
import { errorText, journalList, journalRead, journalUndoPlan, journalUndoRun } from '../lib/api'
import {
  canUndo, changeTexts, currentText, entryResult, entryTargets, formatStamp, formatTime, itemTitle, originLabel,
  reasonText, undoTarget,
} from '../lib/journal'
import type {
  Connection, JournalEntry, JournalEntrySummary, ServerInfo, UndoPlan, UndoResult, UndoRow, UndoState,
} from '../types'
import { ErrorBar, NotConnected, Panel, RefreshButton, ScreenBody, StatsBar, TableMessage, useApiData, useDebounced } from './ApiShell'
import {
  Badge, Button, ButtonGlyph, Checkbox, cx, DataTable, EmptyState, Modal, Notice, Readout, rowClick, SearchInput,
  Segmented, Spinner, Th, THead, type Tone,
} from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  onGoToConnection: () => void
  /** Продуктив: кнопка отмены там красная, как и у самих правок. */
  prod?: boolean
}

type Show = 'all' | 'changes' | 'actions'

/**
 * Журнал изменений, которые инструмент сделал на стенде.
 *
 * Аудит FESB отвечает «кто что сохранил», но не «каким оно было до этого».
 * Здесь — каждая операция инструмента целиком: трассировка двухсот СОПС —
 * одна строка, внутри неё — по строке на СОПС с тем, что было и что стало.
 * По ней же операция и отменяется: целиком или по выбранным строкам.
 */
export function JournalScreen({ connection, server, onGoToConnection, prod }: Props) {
  const { t } = useI18n()
  const load = useCallback((open: Connection) => journalList(open), [])
  const { data, loading, error, reload } = useApiData<JournalEntrySummary[]>(connection, load)

  const [search, setSearch] = useState('')
  const [show, setShow] = useState<Show>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [undoing, setUndoing] = useState<JournalEntrySummary | null>(null)
  const query = useDebounced(search, 250)

  const all = useMemo(() => data ?? [], [data])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return all.filter((entry) => {
      if (show === 'changes' && entry.changes === 0) return false
      if (show === 'actions' && entry.changes > 0) return false
      if (!needle) return true
      return (
        entry.targets.some((target) => target.toLowerCase().includes(needle)) ||
        entry.user.toLowerCase().includes(needle) ||
        originLabel(entry.origin, t).toLowerCase().includes(needle)
      )
    })
  }, [all, query, show, t])

  const totals = useMemo(() => ({
    entries: all.length,
    changes: all.reduce((sum, entry) => sum + entry.changes, 0),
    undone: all.filter((entry) => (entry.undoneBy?.length ?? 0) > 0).length,
  }), [all])

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  if (data !== null && all.length === 0) {
    return (
      <ScreenBody>
        <ErrorBar error={error} />
        <EmptyState icon={ClockCounterClockwise} title={t('journal.empty')} text={t('journal.empty.text')} />
      </ScreenBody>
    )
  }

  return (
    <ScreenBody>
      <StatsBar>
        <Readout label={t('journal.entries')} value={formatNumber(totals.entries)} />
        <Readout label={t('journal.changes')} value={formatNumber(totals.changes)} hint={t('journal.changes.hint')} />
        <Readout label={t('journal.undone')} value={formatNumber(totals.undone)} />
        <div className="ml-auto flex items-center gap-2">
          <RefreshButton className="min-w-32" busy={loading} onClick={() => void reload()} />
        </div>
      </StatsBar>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          className="min-w-64 flex-1"
          value={search}
          placeholder={t('journal.search')}
          onChange={setSearch}
          clearLabel={t('action.clearSearch')}
        />
        <Segmented<Show>
          ariaLabel={t('journal.show')}
          value={show}
          onChange={setShow}
          options={[
            { id: 'all', label: t('journal.show.all') },
            { id: 'changes', label: t('journal.show.changes'), title: t('journal.show.changes.hint') },
            { id: 'actions', label: t('journal.show.actions'), title: t('journal.show.actions.hint') },
          ]}
        />
      </div>

      <ErrorBar error={error} />

      <Panel className="flex-1">
        {/* Таблица по ширине панели: объектов в записи бывает сотня, и их
            колонка забирает остаток, а кнопка отмены не уезжает за край. */}
        <DataTable>
          <colgroup>
            <col className="w-8" />
            <col className="w-32" />
            <col className="w-48" />
            <col />
            <col className="w-36" />
            <col className="hidden w-28 xl:table-column" />
            <col className="w-28" />
          </colgroup>
          <THead>
            <Th />
            <Th>{t('journal.col.when')}</Th>
            <Th>{t('journal.col.operation')}</Th>
            <Th>{t('journal.col.objects')}</Th>
            <Th>{t('journal.col.result')}</Th>
            <Th className="hidden xl:table-cell">{t('journal.col.user')}</Th>
            <Th />
          </THead>
          <tbody>
            {visible.map((entry) => (
              <EntryRows
                key={entry.id}
                entry={entry}
                open={expanded === entry.id}
                onToggle={() => setExpanded((prev) => (prev === entry.id ? null : entry.id))}
                onUndo={() => setUndoing(entry)}
              />
            ))}
            {visible.length === 0 && (
              <TableMessage colSpan={7} busy={loading}>
                {loading ? t('empty.scanning') : t('journal.nothing')}
              </TableMessage>
            )}
          </tbody>
        </DataTable>
      </Panel>

      {undoing && (
        <UndoDialog
          connection={connection}
          entry={undoing}
          prod={prod === true}
          onClose={(changed) => {
            setUndoing(null)
            if (changed) void reload()
          }}
        />
      )}
    </ScreenBody>
  )
}

/** Строка записи и, если она раскрыта, её изменения. */
function EntryRows({ entry, open, onToggle, onUndo }: {
  entry: JournalEntrySummary
  open: boolean
  onToggle: () => void
  onUndo: () => void
}) {
  const { t } = useI18n()
  const undone = (entry.undoneBy?.length ?? 0) > 0
  return (
    <>
      <tr
        onClick={rowClick(onToggle)}
        aria-expanded={open}
        className="cursor-pointer border-b border-line/60 align-top hover:bg-surface-2"
      >
        <td className="py-1.5 pl-3 text-content-subtle">
          {open ? <CaretDown size={12} weight="bold" /> : <CaretRight size={12} weight="bold" />}
        </td>
        <td className="whitespace-nowrap px-3 py-1.5 tabular-nums text-content-muted">{formatStamp(entry.startedAt)}</td>
        <td className="px-3 py-1.5">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{originLabel(entry.origin, t)}</span>
            {undone && <Badge tone="warn">{t('journal.badge.undone')}</Badge>}
          </span>
        </td>
        <td className="truncate px-3 py-1.5" title={entry.targets.join('\n')}>{entryTargets(entry, t)}</td>
        <td className={cx('px-3 py-1.5', entry.failed > 0 && 'text-caution')}>{entryResult(entry, t)}</td>
        <td className="hidden truncate px-3 py-1.5 text-content-muted xl:table-cell">{entry.user}</td>
        <td className="px-3 py-1 text-right">
          {canUndo(entry) && (
            <Button size="sm" onClick={onUndo}>
              <ArrowCounterClockwise size={13} weight="bold" />
              {t('journal.undo')}
            </Button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-line/60 bg-surface-2/40">
          <td colSpan={7} className="px-3 py-2">
            <EntryItems id={entry.id} />
          </td>
        </tr>
      )}
    </>
  )
}

/** Изменения одной записи: что было и что стало. */
function EntryItems({ id }: { id: string }) {
  const { t } = useI18n()
  const [entry, setEntry] = useState<JournalEntry | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    journalRead(id)
      .then((found) => { if (alive) setEntry(found) })
      .catch((err) => { if (alive) setError(errorText(err)) })
    return () => { alive = false }
  }, [id])

  if (error) return <Notice tone="danger" small>{error}</Notice>
  if (!entry) {
    return (
      <div className="flex items-center gap-2 py-1 text-[12px] text-content-muted">
        <Spinner className="size-4" />
        {t('journal.loading')}
      </div>
    )
  }

  return (
    <div className="max-h-96 overflow-auto rounded-lg border border-line bg-surface">
      <table className="w-full table-fixed text-[12px]">
        <colgroup>
          <col className="w-20" />
          <col />
          <col className="w-[26%]" />
          <col className="w-[26%]" />
          <col className="w-32" />
        </colgroup>
        <thead className="bg-surface-2 text-left text-[11px] text-content-subtle">
          <tr>
            <th className="px-2.5 py-1.5 font-medium">{t('journal.col.time')}</th>
            <th className="px-2.5 py-1.5 font-medium">{t('journal.col.object')}</th>
            <th className="px-2.5 py-1.5 font-medium">{t('journal.col.before')}</th>
            <th className="px-2.5 py-1.5 font-medium">{t('journal.col.after')}</th>
            <th className="px-2.5 py-1.5 font-medium">{t('journal.col.outcome')}</th>
          </tr>
        </thead>
        <tbody>
          {entry.items.map((item, index) => {
            const title = itemTitle(item)
            const texts = changeTexts(item, t)
            return (
              <tr key={index} className="border-t border-line/60 align-top">
                <td className="px-2.5 py-1.5 tabular-nums text-content-subtle">{formatTime(item.at)}</td>
                <td className="px-2.5 py-1.5">
                  {title.domain && <div className="truncate text-[11px] text-content-subtle">{title.domain}</div>}
                  <div className="truncate font-medium" title={title.name}>{title.name}</div>
                </td>
                <td className="break-words px-2.5 py-1.5 text-content-muted">{texts.before}</td>
                <td className="break-words px-2.5 py-1.5">{texts.after}</td>
                <td className="px-2.5 py-1.5">
                  {item.error
                    ? <span className="text-negative" title={item.error}>{t('journal.outcome.failed')}</span>
                    : <span className="text-positive">{t('journal.outcome.done')}</span>}
                  {item.error && <div className="mt-0.5 line-clamp-3 text-[11px] text-negative">{item.error}</div>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const STATE_TONE: Record<UndoState, Tone> = {
  ready: 'accent',
  done: 'neutral',
  conflict: 'warn',
  impossible: 'neutral',
}

/**
 * Отмена операции: сначала — что на сервере сейчас и что вернётся.
 *
 * Возвращается только то, что осталось таким, каким его оставил инструмент.
 * Если объект после операции успел поменять кто-то ещё, строка показывает
 * расхождение и не отмечается: затереть чужую правку молча — ровно то,
 * от чего журнал и должен беречь.
 */
function UndoDialog({ connection, entry, prod, onClose }: {
  connection: Connection
  entry: JournalEntrySummary
  prod: boolean
  onClose: (changed: boolean) => void
}) {
  const { t } = useI18n()
  const [plan, setPlan] = useState<UndoPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Set<number>>(new Set())
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<UndoResult | null>(null)

  useEffect(() => {
    let alive = true
    journalUndoPlan(connection, entry.id)
      .then((found) => {
        if (!alive) return
        setPlan(found)
        setChosen(new Set(found.rows.filter((row) => row.state === 'ready').map((row) => row.index)))
      })
      .catch((err) => { if (alive) setError(errorText(err)) })
    return () => { alive = false }
  }, [connection, entry.id])

  const rows = useMemo(() => (plan?.rows ?? []).filter((row) => row.item.type !== 'action'), [plan])
  const ready = rows.filter((row) => row.state === 'ready')
  const counts = useMemo(() => ({
    ready: rows.filter((row) => row.state === 'ready').length,
    done: rows.filter((row) => row.state === 'done').length,
    conflict: rows.filter((row) => row.state === 'conflict').length,
    impossible: rows.filter((row) => row.state === 'impossible').length,
  }), [rows])
  const hasDomains = rows.some((row) => row.item.type === 'domain' && row.state === 'ready')

  const toggle = (index: number) => setChosen((prev) => {
    const next = new Set(prev)
    if (next.has(index)) next.delete(index)
    else next.add(index)
    return next
  })
  const allChosen = ready.length > 0 && ready.every((row) => chosen.has(row.index))

  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      setResult(await journalUndoRun(connection, entry.id, [...chosen].sort((a, b) => a - b)))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setRunning(false)
    }
  }

  const undone = result?.outcomes.filter((outcome) => outcome.status === 'undone').length ?? 0
  const skipped = result?.outcomes.filter((outcome) => outcome.status === 'skipped') ?? []
  const failed = result?.outcomes.filter((outcome) => outcome.status === 'failed') ?? []

  const footer = result ? (
    <Button variant="primary" onClick={() => onClose(true)}>{t('action.close')}</Button>
  ) : (
    <>
      <Button variant="ghost" disabled={running} onClick={() => onClose(false)}>{t('action.cancel')}</Button>
      <Button
        variant={prod ? 'danger' : 'primary'}
        className="min-w-48"
        disabled={running || chosen.size === 0}
        onClick={() => void run()}
      >
        <ButtonGlyph busy={running}><ArrowCounterClockwise size={14} weight="bold" /></ButtonGlyph>
        {t('journal.undo.run', { count: chosen.size })}
      </Button>
    </>
  )

  return (
    <Modal
      open
      width="wide"
      onClose={() => !running && onClose(result !== null)}
      closeLabel={t('action.close')}
      title={t('journal.undo.title', { operation: originLabel(entry.origin, t), when: formatStamp(entry.startedAt) })}
      footer={footer}
    >
      <div className="space-y-3 text-[13px] leading-relaxed">
        {error && <Notice tone="danger">{error}</Notice>}

        {!plan && !error && (
          <div className="flex items-center gap-2 text-[12px] text-content-muted">
            <Spinner className="size-4" />
            {t('journal.undo.checking')}
          </div>
        )}

        {plan && !result && (
          <>
            <p className="text-content-muted">{t('journal.undo.intro')}</p>
            {prod && <Notice tone="warn" small>{t('journal.undo.prod')}</Notice>}
            {hasDomains && <Notice tone="warn" small>{t('journal.undo.domains')}</Notice>}
            <div className="flex flex-wrap gap-1.5">
              {counts.ready > 0 && <Badge tone="accent">{t('journal.undo.count.ready', { count: counts.ready })}</Badge>}
              {counts.done > 0 && <Badge>{t('journal.undo.count.done', { count: counts.done })}</Badge>}
              {counts.conflict > 0 && <Badge tone="warn">{t('journal.undo.count.conflict', { count: counts.conflict })}</Badge>}
              {counts.impossible > 0 && <Badge>{t('journal.undo.count.impossible', { count: counts.impossible })}</Badge>}
            </div>
            {counts.conflict > 0 && <p className="text-[12px] text-caution">{t('journal.undo.conflictHint')}</p>}
            <UndoTable
              rows={rows}
              chosen={chosen}
              allChosen={allChosen}
              onToggle={toggle}
              onToggleAll={() => setChosen(allChosen ? new Set() : new Set(ready.map((row) => row.index)))}
            />
          </>
        )}

        {result && (
          <>
            <Notice tone={failed.length > 0 ? 'warn' : 'ok'}>
              {t('journal.undo.done', { count: undone })}
              {skipped.length > 0 && ` · ${t('journal.undo.skipped', { count: skipped.length })}`}
              {failed.length > 0 && ` · ${t('journal.undo.failed', { count: failed.length })}`}
            </Notice>
            {undone > 0 && <p className="text-[12px] text-content-subtle">{t('journal.undo.recorded')}</p>}
            {[...failed, ...skipped].length > 0 && (
              <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
                {[...failed, ...skipped].map((outcome) => (
                  <div key={outcome.index} className="border-b border-line/60 px-2.5 py-1.5 last:border-b-0">
                    <div className="truncate text-[12px] font-medium">{outcome.title}</div>
                    <div className={cx('mt-0.5 text-[11.5px]', outcome.error ? 'text-negative' : 'text-caution')}>
                      {outcome.error ?? reasonText(outcome.reason, t)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

function UndoTable({ rows, chosen, allChosen, onToggle, onToggleAll }: {
  rows: UndoRow[]
  chosen: Set<number>
  allChosen: boolean
  onToggle: (index: number) => void
  onToggleAll: () => void
}) {
  const { t } = useI18n()
  const readyCount = rows.filter((row) => row.state === 'ready').length
  return (
    <div className="max-h-96 overflow-auto rounded-lg border border-line">
      <table className="w-full table-fixed text-[12px]">
        <colgroup>
          <col className="w-9" />
          <col />
          <col className="w-[27%]" />
          <col className="w-[27%]" />
          <col className="w-36" />
        </colgroup>
        <thead className="sticky top-0 bg-surface-2 text-left text-[11px] text-content-subtle">
          <tr>
            <th className="px-2.5 py-1.5">
              <Checkbox
                aria-label={t('journal.undo.chooseAll')}
                checked={allChosen}
                disabled={readyCount === 0}
                onChange={onToggleAll}
              />
            </th>
            <th className="px-2.5 py-1.5 font-medium">{t('journal.col.object')}</th>
            <th className="px-2.5 py-1.5 font-medium">{t('journal.undo.col.now')}</th>
            <th className="px-2.5 py-1.5 font-medium">{t('journal.undo.col.will')}</th>
            <th className="px-2.5 py-1.5 font-medium">{t('journal.undo.col.state')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const title = itemTitle(row.item)
            const texts = changeTexts(row.item, t)
            // «Уже как было» — на стенде прежнее значение, «изменено после» — чужое.
            const now = row.state === 'conflict'
              ? currentText(row, t) ?? texts.after
              : row.state === 'done' ? texts.before : texts.after
            const ready = row.state === 'ready'
            return (
              <tr
                key={row.index}
                onClick={ready ? rowClick(() => onToggle(row.index)) : undefined}
                className={cx('border-t border-line/60 align-top', ready && 'cursor-pointer hover:bg-surface-2')}
              >
                <td className="px-2.5 py-1.5">
                  <Checkbox
                    aria-label={title.name}
                    checked={chosen.has(row.index)}
                    disabled={!ready}
                    onChange={() => onToggle(row.index)}
                  />
                </td>
                <td className="px-2.5 py-1.5">
                  {title.domain && <div className="truncate text-[11px] text-content-subtle">{title.domain}</div>}
                  <div className="truncate font-medium" title={title.name}>{title.name}</div>
                </td>
                <td className={cx('break-words px-2.5 py-1.5', row.state === 'conflict' ? 'text-caution' : 'text-content-muted')}>
                  {row.item.type === 'domain' ? '—' : now}
                </td>
                <td className="break-words px-2.5 py-1.5">{ready ? undoTarget(row, t) : '—'}</td>
                <td className="px-2.5 py-1.5">
                  <Badge tone={STATE_TONE[row.state]}>{reasonText(row.state, t)}</Badge>
                  {row.reason && row.state !== 'ready' && (
                    <div className="mt-0.5 text-[11px] text-content-subtle">{reasonText(row.reason, t)}</div>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
