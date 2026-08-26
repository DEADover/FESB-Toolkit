import { useEffect, useRef, type MouseEvent, type ReactNode } from 'react'

import { useI18n } from '../i18n'
import type { DomainGroup, SortDir, SortKey, TraceEntry } from '../lib/rows'
import { changeKey, routeSummary, routesUsingBean, selectableKeys } from '../lib/rows'
import type { DomainRecord, RouteInfo, TraceBean, TraceUpdate } from '../types'
import { Badge, Checkbox, SortHead, cx } from './ui'

interface Props {
  groups: DomainGroup[]
  selected: Set<string>
  /** Ключи вида `путь::beanId` — что уже изменено в этой сессии. */
  changedBeans: Set<string>
  expanded: Set<string>
  sortKey: SortKey
  sortDir: SortDir
  update: TraceUpdate
  onToggleEntry: (key: string, event: MouseEvent) => void
  onToggleGroup: (group: DomainGroup) => void
  onToggleAll: () => void
  onToggleExpand: (id: string) => void
  onSort: (key: SortKey) => void
  onReveal: (path: string) => void
  /** Открывает схему СОПС: путь к файлу маршрута и имя домена. */
  onOpenRoute: (path: string, domainName: string) => void
}

const COLUMN_COUNT = 9

/** Клик, завершающий выделение текста, не должен сворачивать строку. */
function hasTextSelection(): boolean {
  return (window.getSelection()?.toString().length ?? 0) > 0
}

/**
 * Домены с раскрытием. Подробности домена — его объекты трассировки и СОПС —
 * показываются обычными строками той же таблицы, поэтому колонки остаются
 * на месте: то, что стоит под «Broker», всегда брокер.
 */
export function TraceTable({
  groups, selected, changedBeans, expanded, sortKey, sortDir, update,
  onToggleEntry, onToggleGroup, onToggleAll, onToggleExpand, onSort, onReveal, onOpenRoute,
}: Props) {
  const { t } = useI18n()
  const headCheckbox = useRef<HTMLInputElement>(null)

  const selectable = selectableKeys(groups)
  const selectedCount = selectable.filter((key) => selected.has(key)).length

  useEffect(() => {
    if (headCheckbox.current) {
      headCheckbox.current.indeterminate = selectedCount > 0 && selectedCount < selectable.length
    }
  }, [selectedCount, selectable.length])

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-surface">
      <table className="w-full table-fixed border-separate border-spacing-0 text-[12.5px]">
        {/* Домен и маршруты получают всё свободное место, брокеру хватает узкой колонки. */}
        <colgroup>
          <col className="w-9" />
          <col className="w-10" />
          <col />
          <col className="w-36" />
          <col className="w-36" />
          <col className="w-40" />
          <col className="w-24" />
          <col className="w-20" />
          <col className="w-16" />
        </colgroup>

        <thead className="sticky top-0 z-10">
          <tr className="bg-surface-2 text-left text-[11.5px] text-content-subtle">
            <th className="border-b border-line px-3 py-2.5">
              <LineBox>
              <Checkbox
                ref={headCheckbox}
                checked={selectable.length > 0 && selectedCount === selectable.length}
                onChange={onToggleAll}
                disabled={selectable.length === 0}
                aria-label={t('filter.all')}
              />
              </LineBox>
            </th>
            <th className="border-b border-line px-2 py-2.5 text-center font-medium" title={t('table.changed')}>
              <PencilIcon />
            </th>
            <SortHead label={t('table.domain')} sortKey="domain" active={sortKey} dir={sortDir} onSort={onSort} />
            <SortHead label={t('table.traceBean')} sortKey="bean" active={sortKey} dir={sortDir} onSort={onSort} />
            <SortHead label={t('table.broker')} sortKey="broker" active={sortKey} dir={sortDir} onSort={onSort} />
            <th className="border-b border-line px-3 py-2.5 font-medium">{t('table.queue')}</th>
            <th className="border-b border-line px-3 py-2.5 font-medium">{t('table.traceMode')}</th>
            <SortHead label={t('table.routes')} sortKey="routes" active={sortKey} dir={sortDir} onSort={onSort} />
            <th className="border-b border-line px-3 py-2.5 font-medium">{t('table.file')}</th>
          </tr>
        </thead>

        {groups.map((group) => {
          const domain = group.domain
          const groupKeys = group.entries.filter((entry) => entry.editable).map((entry) => entry.key)
          const groupSelected = groupKeys.filter((key) => selected.has(key)).length
          const single = group.entries.length === 1 ? group.entries[0] : null
          const isOpen = expanded.has(domain.id)
          const routes = routeSummary(domain)
          const domainChanged = group.entries.some((entry) => changedBeans.has(changeKey(domain, entry.trace.beanId)))

          return (
            <tbody key={domain.id}>
              <tr
                onClick={() => { if (!hasTextSelection()) onToggleExpand(domain.id) }}
                title={domain.startActive === false ? t('table.stoppedHint') : undefined}
                className={cx(
                  'group cursor-pointer transition-colors',
                  // Остановленный домен приглушаем целиком — отдельная пилюля не нужна.
                  domain.startActive === false && 'opacity-55',
                  groupSelected > 0 ? 'bg-accent/10' : 'hover:bg-surface-2',
                )}
              >
                <Cell>
                  <LineBox>
                    <GroupCheckbox
                      total={groupKeys.length}
                      selected={groupSelected}
                      label={domain.domainName}
                      onToggle={() => onToggleGroup(group)}
                    />
                  </LineBox>
                </Cell>

                <ChangedCell changed={domainChanged} />

                <Cell>
                  <div className="flex items-center gap-2">
                    <span className={cx('w-3 shrink-0 text-[10px] text-content-subtle transition-transform', isOpen && 'rotate-90')}>▶</span>
                    <span className="select-text truncate font-medium text-content">{domain.domainName}</span>
                    {domain.errors.length > 0 && <Badge tone="danger">{t('table.readError')}</Badge>}
                  </div>
                </Cell>

                {single ? (
                  <>
                    <Cell className="font-mono text-[11.5px] text-content-muted">{single.trace.beanId ?? '—'}</Cell>
                    <Cell><ValueCell current={single.trace.broker} editable={single.trace.brokerEditable} next={selected.has(single.key) ? update.broker : null} /></Cell>
                    <Cell><ValueCell current={single.trace.queue} editable={single.trace.queueEditable} next={selected.has(single.key) ? update.queue : null} /></Cell>
                    <Cell><ValueCell current={single.trace.traceMode} editable={single.trace.traceModeEditable} next={selected.has(single.key) ? update.traceMode : null} /></Cell>
                  </>
                ) : (
                  <>
                    <Cell className="text-[11.5px] text-content-subtle">
                      {group.entries.length === 0
                        ? t('table.noTraceBean')
                        : <Multi count={group.entries.length} hint={t('table.multiBeans', { count: group.entries.length })} />}
                    </Cell>
                    <Cell><Summary group={group} pick={(trace) => trace.broker} /></Cell>
                    <Cell><Summary group={group} pick={(trace) => trace.queue} /></Cell>
                    <Cell><Summary group={group} pick={(trace) => trace.traceMode} /></Cell>
                  </>
                )}

                <Cell><RoutesCount routes={routes} /></Cell>

                <Cell>
                  <RevealButton path={domain.domainXmlPath} onReveal={onReveal} />
                </Cell>
              </tr>

              {isOpen && (
                <>
                  <SubRow>
                    <Cell />
                    <Cell />
                    <Cell colSpanRest>
                      <div className="flex flex-col gap-1 pl-5 text-[11.5px] text-content-subtle">
                        {domain.description && <Fact label={t('table.description')} value={domain.description} />}
                        <Fact label={t('table.guid')} value={domain.guid} mono />
                        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
                          <Fact label={t('table.startMode')} value={domain.startMode} />
                          <span>
                            {t('table.state')}:{' '}
                            <span className={domain.startActive ? 'text-positive' : 'text-content-muted'}>
                              {domain.startActive ? t('table.active') : t('table.stopped')}
                            </span>
                          </span>
                        </div>
                      </div>
                      {domain.errors.map((error) => (
                        <div key={error} className="pl-5 text-[11.5px] text-negative">{error}</div>
                      ))}
                    </Cell>
                  </SubRow>

                  <SectionRow label={t('panel.traceBeans')} count={group.entries.length} />
                  {group.entries.length === 0 ? (
                    <SubRow>
                      <Cell />
                      <Cell />
                      <Cell colSpanRest className="pl-9 text-[11.5px] text-content-subtle">{t('panel.noTraceBeans')}</Cell>
                    </SubRow>
                  ) : (
                    group.entries.map((entry, index) => (
                      <BeanRow
                        key={entry.key}
                        entry={entry}
                        number={index + 1}
                        changed={changedBeans.has(changeKey(domain, entry.trace.beanId))}
                        domain={domain}
                        selected={selected.has(entry.key)}
                        update={update}
                        onToggle={onToggleEntry}
                      />
                    ))
                  )}

                  <SectionRow
                    label={t('panel.routes')}
                    count={domain.routes.length}
                    note={routes.total > 0 ? t('table.routesHint', { traced: routes.traced, total: routes.total }) : undefined}
                  />
                  {domain.routes.length === 0 ? (
                    <SubRow>
                      <Cell />
                      <Cell />
                      <Cell colSpanRest className="pl-9 text-[11.5px] text-content-subtle">{t('panel.noRoutes')}</Cell>
                    </SubRow>
                  ) : (
                    domain.routes.map((route, index) => (
                      <RouteRow
                        key={`${route.file}-${route.id ?? index}`}
                        route={route}
                        onReveal={() => onReveal(`${domain.dirPath}/routes/${route.file}`)}
                        onOpen={() => onOpenRoute(`${domain.dirPath}/routes/${route.file}`, domain.domainName)}
                      />
                    ))
                  )}
                </>
              )}
            </tbody>
          )
        })}

        {groups.length === 0 && (
          <tbody>
            <tr>
              <td colSpan={COLUMN_COUNT} className="px-4 py-16 text-center text-content-subtle">{t('table.empty')}</td>
            </tr>
          </tbody>
        )}
      </table>
    </div>
  )
}

/* ------------------------------ Строки таблицы ------------------------------ */

function Cell({ children, className, colSpanRest }: { children?: ReactNode; className?: string; colSpanRest?: boolean }) {
  // Отступ по умолчанию задаётся только если вызывающий не задал свой: иначе
  // `py-2` из базового класса перебивает `py-1.5` — в CSS оно идёт позже.
  const ownPadding = className?.includes('py-')
  return (
    <td
      colSpan={colSpanRest ? COLUMN_COUNT - 2 : undefined}
      className={cx('border-b border-line px-3 align-top', !ownPadding && 'py-2', className)}
    >
      {children}
    </td>
  )
}

function SubRow({ children, className, onClick, selected }: {
  children: ReactNode
  className?: string
  onClick?: (event: MouseEvent) => void
  selected?: boolean
}) {
  return (
    <tr
      onClick={onClick}
      className={cx('transition-colors', selected ? 'bg-accent/12' : 'bg-surface-2/50', onClick && 'cursor-pointer hover:bg-surface-3', className)}
    >
      {children}
    </tr>
  )
}

function SectionRow({ label, count, note }: { label: string; count: number; note?: string }) {
  return (
    <SubRow>
      <Cell />
      <Cell />
      <Cell colSpanRest className="py-1.5">
        <div className="flex items-center gap-2 pl-5">
          <span className="text-[11px] font-semibold tracking-wide text-content-muted">{label}</span>
          <Badge>{count}</Badge>
          {note && <span className="text-[11px] text-content-subtle">{note}</span>}
        </div>
      </Cell>
    </SubRow>
  )
}

function BeanRow({ entry, number, changed, domain, selected, update, onToggle }: {
  entry: TraceEntry
  number: number
  changed: boolean
  domain: DomainRecord
  selected: boolean
  update: TraceUpdate
  onToggle: (key: string, event: MouseEvent) => void
}) {
  const { t } = useI18n()
  return (
    <SubRow
      selected={selected}
      onClick={entry.editable ? (event) => { if (!hasTextSelection()) onToggle(entry.key, event) } : undefined}
    >
      <Cell className="py-1.5">
        <LineBox compact>
          <Checkbox
            checked={selected}
            disabled={!entry.editable}
            onChange={() => { /* обрабатывается кликом по строке */ }}
            onClick={(event) => { event.stopPropagation(); if (entry.editable) onToggle(entry.key, event) }}
            aria-label={entry.trace.beanId ?? ''}
          />
        </LineBox>
      </Cell>
      <ChangedCell changed={changed} compact />
      <Cell className="py-1.5">
        <span className="ml-5 block border-l border-line-strong pl-3 text-[11.5px] tabular-nums text-content-subtle">{number}</span>
      </Cell>
      <Cell className="select-text py-1.5 font-mono text-[11.5px] text-content">{entry.trace.beanId ?? '—'}</Cell>
      <Cell className="py-1.5"><ValueCell current={entry.trace.broker} editable={entry.trace.brokerEditable} next={selected ? update.broker : null} /></Cell>
      <Cell className="py-1.5"><ValueCell current={entry.trace.queue} editable={entry.trace.queueEditable} next={selected ? update.queue : null} /></Cell>
      <Cell className="py-1.5"><ValueCell current={entry.trace.traceMode} editable={entry.trace.traceModeEditable} next={selected ? update.traceMode : null} /></Cell>
      <Cell className="py-1.5 font-mono text-[11.5px] tabular-nums text-content-muted">
        <span title={t('table.usedByHint')}>{routesUsingBean(domain, entry.trace.beanId)}</span>
      </Cell>
      <Cell className="py-1.5" />
    </SubRow>
  )
}

function RouteRow({ route, onReveal, onOpen }: { route: RouteInfo; onReveal: () => void; onOpen: () => void }) {
  const { t } = useI18n()
  return (
    <SubRow>
      <Cell className="py-1.5" />
      <Cell className="py-1.5" />
      <Cell className="py-1.5">
        <div className="ml-5 min-w-0 border-l border-line-strong pl-3">
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); onOpen() }}
            title={t('route.openHint')}
            className={cx(
              'block w-full truncate text-left transition hover:text-accent-content hover:underline',
              !route.name && 'text-content-subtle',
            )}
          >
            {route.name ?? t('routes.unknownName')}
          </button>
          <div className="select-text font-mono text-[10px] text-content-subtle">{route.id}</div>
        </div>
      </Cell>
      <Cell className="py-1.5">
        {route.inlineTraceConfig ? (
          <Badge tone="warn">{t('routes.inlineConfig')}</Badge>
        ) : route.traceConfigs.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {route.traceConfigs.map((name) => (
              <code key={name} className="rounded bg-surface px-1.5 py-0.5 font-mono text-[11px] text-content-muted">{name}</code>
            ))}
          </div>
        ) : (
          <span className="text-[11.5px] text-content-subtle">{route.traceEnabled ? t('routes.defaultConfig') : '—'}</span>
        )}
      </Cell>
      <Cell className="py-1.5" />
      <Cell className="py-1.5" />
      <Cell className="py-1.5" />
      <Cell className="py-1.5">
        <Badge tone={route.traceEnabled ? 'ok' : 'neutral'}>
          {route.traceEnabled ? t('routes.trace.on') : t('routes.trace.off')}
        </Badge>
      </Cell>
      <Cell className="py-1.5">
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); onReveal() }}
          className="-ml-1.5 rounded px-1.5 py-0.5 text-[11px] text-content-subtle transition hover:bg-surface-3 hover:text-accent-content"
          title={route.file}
        >
          {t('action.show')}
        </button>
      </Cell>
    </SubRow>
  )
}

/* -------------------------------- Мелочи -------------------------------- */

function RevealButton({ path, onReveal }: { path: string; onReveal: (path: string) => void }) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      onClick={(event) => { event.stopPropagation(); onReveal(path) }}
      className="-ml-1.5 rounded px-1.5 py-0.5 text-[11.5px] text-content-subtle transition hover:bg-surface-3 hover:text-accent-content"
      title={path}
    >
      {t('action.show')}
    </button>
  )
}

function Fact({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  if (!value) return null
  return (
    <span>
      {label}: <span className={cx('select-text text-content-muted', mono && 'font-mono text-[10.5px]')}>{value}</span>
    </span>
  )
}

function GroupCheckbox({ total, selected, label, onToggle }: {
  total: number
  selected: number
  label: string
  onToggle: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = selected > 0 && selected < total
  }, [selected, total])

  return (
    <Checkbox
      ref={ref}
      checked={total > 0 && selected === total}
      disabled={total === 0}
      onChange={() => { /* обрабатывается кликом по чекбоксу */ }}
      onClick={(event) => { event.stopPropagation(); if (total > 0) onToggle() }}
      aria-label={label}
    />
  )
}

/** Заголовок колонки правок: карандаш понятнее слова и занимает вчетверо меньше места. */
function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" className="mx-auto size-3.5 text-content-subtle" fill="currentColor" aria-hidden>
      <path d="M11.1 1.2a1 1 0 0 1 1.4 0l2.3 2.3a1 1 0 0 1 0 1.4l-1 1-3.7-3.7zM9.2 3.1l3.7 3.7-7 7a1 1 0 0 1-.5.3l-3.6.9a.5.5 0 0 1-.6-.6l.9-3.6a1 1 0 0 1 .3-.5z" />
    </svg>
  )
}

/**
 * Коробка высотой в одну строку текста. Всё, что в неё попадает — чекбокс,
 * точка, — центрируется по первой строке ячейки, а не по высоте всей строки:
 * соседние колонки выровнены по верху, и центрирование по строке их бы не совпало.
 */
function LineBox({ compact, className, children }: { compact?: boolean; className?: string; children?: ReactNode }) {
  return (
    <span className={cx('flex h-[1.5em] items-center', compact ? 'text-[11.5px]' : 'text-[12.5px]', className)}>
      {children}
    </span>
  )
}

/**
 * Колонка-сигнал: запись изменена в текущей сессии.
 *
 * Точка живёт в собственной колонке фиксированной ширины, поэтому по горизонтали
 * ни на что не влияет. По вертикали центрируется не по высоте строки, а по первой
 * строке текста — как и содержимое соседних колонок, выровненных по верху.
 */
function ChangedCell({ changed, compact }: { changed: boolean; compact?: boolean }) {
  const { t } = useI18n()
  return (
    <td className={cx('border-b border-line px-2 align-top', compact ? 'py-1.5' : 'py-2')}>
      <LineBox compact={compact} className="justify-center">
        {changed && <span title={t('table.changed')} className="size-1.5 rounded-full bg-positive" />}
      </LineBox>
    </td>
  )
}

function ValueCell({ current, editable, next }: { current: string | null; editable: boolean; next: string | null }) {
  const { t } = useI18n()
  if (!editable) {
    return <span className="text-[11.5px] text-content-subtle">{t('table.noProperty')}</span>
  }
  const willChange = next !== null && next !== '' && next !== current
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <code className={cx('rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11.5px]', willChange && 'text-content-subtle line-through')}>
        {current}
      </code>
      {willChange && (
        <>
          <span className="text-accent-content">→</span>
          <code className="rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[11.5px] text-accent-content">{next}</code>
        </>
      )}
    </div>
  )
}

/** MULTI — значения у объектов трассировки домена различаются. */
function Multi({ count, hint }: { count: number; hint?: string }) {
  const { t } = useI18n()
  return (
    <span
      className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[11px] font-medium tracking-wide text-content-muted"
      title={hint ?? t('table.multiHint', { count })}
    >
      {t('table.multi')}
    </span>
  )
}

/**
 * Значение домена с несколькими объектами трассировки: общее значение, если оно
 * у всех одинаковое, иначе MULTI.
 */
function Summary({ group, pick }: { group: DomainGroup; pick: (trace: TraceBean) => string | null }) {
  const values = group.entries.map((entry) => pick(entry.trace))
  const distinct = [...new Set(values.filter((value): value is string => value !== null))]

  if (distinct.length === 0) return <span className="text-content-subtle">—</span>
  if (distinct.length > 1) return <Multi count={group.entries.length} />
  return (
    <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11.5px] text-content-muted">{distinct[0]}</code>
  )
}

function RoutesCount({ routes }: { routes: ReturnType<typeof routeSummary> }) {
  const { t } = useI18n()
  if (routes.total === 0) return <span className="text-[11.5px] text-content-subtle">—</span>
  return (
    <span
      className="whitespace-nowrap font-mono text-[11.5px] tabular-nums"
      title={t('table.routesHint', { traced: routes.traced, total: routes.total })}
    >
      <span className={routes.traced > 0 ? 'text-accent-content' : 'text-content-subtle'}>{routes.traced}</span>
      <span className="text-content-subtle"> / {routes.total}</span>
    </span>
  )
}
