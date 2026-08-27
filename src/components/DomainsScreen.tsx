import { useCallback, useEffect, useMemo, useState } from 'react'

import { ArrowsClockwise, CaretDown, Play, Stop } from '@phosphor-icons/react'

import { useI18n } from '../i18n'
import { apiDomainAction, apiDomains, apiDomainStatistics, errorText } from '../lib/api'
import type { ApiDomain, ApiProgress, Connection, DomainAction, DomainStat, ServerInfo } from '../types'
import {
  AutoRefreshToggle, NotConnected, RefreshButton, ScreenBody, TableMessage, useAutoRefresh,
} from './ApiShell'
import { Badge, Button, Checkbox, cx, DataTable, FOCUS_RING, IconButton, Modal, Notice, Readout, SearchInput, Spinner, Th, THead, Toggle } from './ui'

/** Что делать с доменами после выгрузки. */
export type PullIntent = 'edit' | 'archive'

type SortKey = 'name' | 'routes' | 'success' | 'errors' | 'inflight'

/** Домен вместе со счётчиками: список и статистика сведены по guid. */
interface Row extends ApiDomain {
  routes: number
  running: number
  success: number
  errors: number
  inflight: number
  /** Домен поднят, но часть его СОПС не работает — то, ради чего была карта. */
  limping: boolean
}

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  pulling: boolean
  progress: ApiProgress | null
  /** Ошибка последней выгрузки — приходит из App, где живёт сам вызов. */
  error: string | null
  onPull: (guids: string[] | null, intent: PullIntent) => void
  /** Переход к СОПС домена: видно, что часть не запущена — лечат уже там. */
  onOpenRoutes: (guid: string) => void
  onGoToConnection: () => void
}

/**
 * Список доменов сервера: отсюда выбирают, что забрать в редактор.
 *
 * Выгрузка всех доменов сразу занимает минуты, поэтому выбор нескольких —
 * основной путь, а «забрать все» вынесено отдельной кнопкой с предупреждением.
 */
export function DomainsScreen({ connection, server, pulling, progress, error: pullError, onPull, onOpenRoutes, onGoToConnection }: Props) {
  const { t } = useI18n()
  const [domains, setDomains] = useState<ApiDomain[] | null>(null)
  const [stats, setStats] = useState<DomainStat[]>([])
  const [onlyTrouble, setOnlyTrouble] = useState(false)
  const [sort, setSort] = useState<SortKey>('name')
  const [auto, setAuto] = useState(false)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [onlyActive, setOnlyActive] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ domain: ApiDomain; action: DomainAction } | null>(null)
  /** Домен, который шина отказалась запускать: причина остаётся в журнале. */
  const [refused, setRefused] = useState<ApiDomain | null>(null)
  /** Массовое действие: сколько сделано и что ответила шина по каждому домену. */
  const [bulk, setBulk] = useState<{
    action: DomainAction
    total: number
    done: number
    results: Array<{ name: string; done: boolean; error: string | null }>
    finished: boolean
  } | null>(null)
  const [confirmBulk, setConfirmBulk] = useState<DomainAction | null>(null)
  /**
   * Что забираем, пока не выбрано, зачем.
   *
   * `undefined` — вопрос не задан, `null` — забираем все домены,
   * массив — выбранные. Различать нужно, потому что «все» и «пустой список»
   * для сервера не одно и то же.
   */
  const [asking, setAsking] = useState<string[] | null | undefined>(undefined)

  const load = useCallback(async () => {
    if (!connection) return
    setLoading(true)
    setListError(null)
    try {
      // Список и счётчики — два разных вызова шины, но одна таблица:
      // раньше они жили на разных экранах, и «где болит» приходилось
      // смотреть отдельно от «что с этим делать».
      const [list, numbers] = await Promise.all([
        apiDomains(connection),
        apiDomainStatistics(connection).catch(() => [] as DomainStat[]),
      ])
      setDomains(list)
      setStats(numbers)
    } catch (err) {
      setListError(errorText(err))
      setDomains(null)
    } finally {
      setLoading(false)
    }
  }, [connection])

  // Список подтягивается сам, как только подключение подтверждено.
  useEffect(() => {
    if (server) void load()
    else setDomains(null)
  }, [server, load])

  useAutoRefresh(auto, load)

  const rows = useMemo<Row[]>(() => {
    if (!domains) return []
    const byGuid = new Map(stats.map((item) => [item.guid, item]))
    return domains.map((domain) => {
      const numbers = byGuid.get(domain.guid)
      const routes = numbers?.routes ?? 0
      const running = numbers?.running ?? 0
      return {
        ...domain,
        routes,
        running,
        success: numbers?.success ?? 0,
        errors: numbers?.errors ?? 0,
        inflight: numbers?.inflight ?? 0,
        limping: domain.active && routes > 0 && running < routes,
      }
    })
  }, [domains, stats])

  const totals = useMemo(() => rows.reduce((sum, item) => ({
    domains: sum.domains + 1,
    active: sum.active + (item.active ? 1 : 0),
    routes: sum.routes + item.routes,
    running: sum.running + item.running,
    success: sum.success + item.success,
    errors: sum.errors + item.errors,
    inflight: sum.inflight + item.inflight,
  }), { domains: 0, active: 0, routes: 0, running: 0, success: 0, errors: 0, inflight: 0 }), [rows])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const kept = rows.filter((domain) => {
      if (onlyActive && !domain.active) return false
      // «Есть на что посмотреть» — ошибки, зависшие сообщения или хромой домен.
      if (onlyTrouble && domain.errors === 0 && domain.inflight === 0 && !domain.limping) return false
      if (!needle) return true
      return (
        domain.name.toLowerCase().includes(needle) ||
        domain.guid.toLowerCase().includes(needle) ||
        (domain.group ?? '').toLowerCase().includes(needle)
      )
    })
    const by = (item: Row) => {
      switch (sort) {
        case 'routes': return item.routes
        case 'success': return item.success
        case 'errors': return item.errors
        case 'inflight': return item.inflight
        default: return 0
      }
    }
    return sort === 'name'
      ? [...kept].sort((a, b) => a.name.localeCompare(b.name))
      : [...kept].sort((a, b) => by(b) - by(a) || a.name.localeCompare(b.name))
  }, [rows, query, onlyActive, onlyTrouble, sort])

  const act = useCallback(async (domain: ApiDomain, action: DomainAction) => {
    if (!connection) return
    setConfirm(null)
    setRefused(null)
    setPending(`${domain.guid}:${action}`)
    setListError(null)
    try {
      const result = await apiDomainAction(connection, domain.guid, action)
      if (!result.done) setRefused(domain)
      await load()
    } catch (err) {
      setListError(errorText(err))
    } finally {
      setPending(null)
    }
  }, [connection, load])

  /** Запуск безобиден, остановка и перезапуск рвут обработку — спрашиваем. */
  const startAction = useCallback((domain: ApiDomain, action: DomainAction) => {
    if (action === 'start') void act(domain, action)
    else setConfirm({ domain, action })
  }, [act])

  /**
   * Массовое действие над выбранными доменами.
   *
   * Строго по очереди: поднять десяток доменов разом — заметная нагрузка
   * на шину, а торопиться тут некуда. Отказ одного не останавливает
   * остальных, но остаётся в сводке: шина отвечает `200` и телом `false`,
   * и такой домен легко потерять.
   */
  const runBulk = useCallback(async (action: DomainAction) => {
    if (!connection) return
    setConfirmBulk(null)
    const targets = (domains ?? []).filter((domain) => selected.has(domain.guid))
    if (targets.length === 0) return

    setBulk({ action, total: targets.length, done: 0, results: [], finished: false })
    setListError(null)

    for (const domain of targets) {
      let done = false
      let error: string | null = null
      try {
        done = (await apiDomainAction(connection, domain.guid, action)).done
      } catch (err) {
        error = errorText(err)
      }
      setBulk((prev) => prev && {
        ...prev,
        done: prev.done + 1,
        results: [...prev.results, { name: domain.name, done, error }],
      })
    }

    setBulk((prev) => prev && { ...prev, finished: true })
    await load()
  }, [connection, domains, selected, load])

  const toggle = useCallback((guid: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(guid)) next.delete(guid)
      else next.add(guid)
      return next
    })
  }, [])

  const toggleVisible = useCallback(() => {
    const keys = visible.map((domain) => domain.guid)
    setSelected((prev) => {
      const next = new Set(prev)
      const all = keys.length > 0 && keys.every((key) => next.has(key))
      for (const key of keys) {
        if (all) next.delete(key)
        else next.add(key)
      }
      return next
    })
  }, [visible])

  // На этом экране заглушка своя: с неё уводят прямо на подключение.
  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  const allVisibleSelected = visible.length > 0 && visible.every((domain) => selected.has(domain.guid))

  return (
    <ScreenBody>
      {/*
        Сводка по всему серверу: раньше она жила отдельной «Картой доменов»,
        и чтобы от «где болит» перейти к «останови и забери» приходилось
        менять экран. Это один и тот же список одних и тех же доменов.
      */}
      <div className="flex items-center gap-7 rounded-xl border border-line bg-surface px-5 py-3.5">
        <Readout label={t('map.domains')} value={`${totals.active} / ${totals.domains}`} hint={t('map.domains.hint')} />
        <Readout label={t('map.routes')} value={`${totals.running} / ${totals.routes}`} hint={t('map.routes.hint')} />
        <Readout label={t('map.success')} value={totals.success.toLocaleString()} />
        <Readout label={t('map.errors')} value={totals.errors.toLocaleString()} tone={totals.errors > 0 ? 'danger' : undefined} />
        <Readout label={t('map.inflight')} value={totals.inflight.toLocaleString()} tone={totals.inflight > 0 ? 'warn' : undefined} />
        <div className="ml-auto flex items-center gap-2">
          <AutoRefreshToggle checked={auto} onChange={setAuto} />
          <RefreshButton busy={loading} disabled={loading || pulling} onClick={() => void load()} />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <SearchInput
          className="flex-1"
          value={query}
          placeholder={t('api.domains.search')}
          onChange={setQuery}
        />
        <Toggle checked={onlyActive} onChange={setOnlyActive} label={t('api.domains.onlyActive')} />
        <Toggle
          checked={onlyTrouble}
          onChange={setOnlyTrouble}
          label={t('map.onlyTrouble')}
          title={t('map.onlyTrouble.hint')}
        />
      </div>

      {refused && (
        <Notice tone="warn">
          {t('domains.refused', { name: refused.name })}
        </Notice>
      )}

      {(listError ?? pullError) && (
        <Notice tone="danger">
          {listError ?? pullError}
        </Notice>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-surface">
        <DataTable>
          {/* Счётчики уходят на узком окне: имя и состояние домена важнее. */}
          <colgroup>
            <col className="w-9" />
            <col />
            <col className="w-28" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="hidden w-20 xl:table-column" />
            <col className="hidden w-24 xl:table-column" />
            <col className="w-28" />
          </colgroup>
          <THead>
              <Th className="px-2">
                <Checkbox
                  checked={allVisibleSelected}
                  onChange={toggleVisible}
                  aria-label={t('api.domains.selectAll')}
                />
              </Th>
              <SortColumn label={t('table.domain')} id="name" sort={sort} onSort={setSort} align="left" />
              <Th className="px-2">{t('table.state')}</Th>
              <SortColumn label={t('map.routes')} id="routes" sort={sort} onSort={setSort} />
              <SortColumn label={t('map.errors')} id="errors" sort={sort} onSort={setSort} />
              <SortColumn label={t('map.inflight')} id="inflight" sort={sort} onSort={setSort} className="hidden xl:table-cell" />
              <SortColumn label={t('map.success')} id="success" sort={sort} onSort={setSort} className="hidden xl:table-cell" />
              <Th className="px-2">{t('modules.actions')}</Th>
            </THead>
          <tbody>
            {visible.map((domain) => (
              <tr
                key={domain.guid}
                onClick={() => toggle(domain.guid)}
                className={cx(
                  'cursor-pointer border-b border-line/60 transition',
                  selected.has(domain.guid) ? 'bg-accent/8' : 'hover:bg-surface-2',
                  !domain.active && 'text-content-subtle',
                )}
              >
                <td className="px-2 py-1.5">
                  <Checkbox
                    checked={selected.has(domain.guid)}
                    onChange={() => toggle(domain.guid)}
                    onClick={(event) => event.stopPropagation()}
                    aria-label={domain.name}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 truncate font-medium" title={domain.name}>{domain.name}</span>
                    {domain.leader && <Badge tone="accent">{t('api.domains.leader')}</Badge>}
                    {domain.clustered && <Badge>{t('api.domains.clustered')}</Badge>}
                  </div>
                  {/*
                    Guid и группа — подписью под именем, а не колонками.
                    Колонка под guid на узком окне съедала имя домена, а сам
                    guid нужен, чтобы его выделить и унести в тикет: здесь он
                    виден всегда и на любой ширине.
                  */}
                  <div className="truncate font-mono text-[10.5px] text-content-subtle" title={domain.guid}>
                    {domain.group ? `${domain.group} · ` : ''}{domain.guid}
                  </div>
                </td>
                <td className="px-2 py-1.5">
                  {domain.limping
                    ? <Badge tone="warn" title={t('map.notAllRunning.hint')}>{t('map.notAllRunning')}</Badge>
                    : domain.active
                      ? <Badge tone="ok">{t('table.active')}</Badge>
                      : <Badge>{t('table.stopped')}</Badge>}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums" onClick={(event) => event.stopPropagation()}>
                  {domain.routes > 0 ? (
                    <button
                      type="button"
                      title={t('map.openRoutes')}
                      onClick={() => onOpenRoutes(domain.guid)}
                      className={cx('rounded px-1 tabular-nums transition hover:text-accent-content hover:underline', FOCUS_RING)}
                    >
                      {domain.running} / {domain.routes}
                    </button>
                  ) : '—'}
                </td>
                <td className={cx('px-2 py-1.5 text-right tabular-nums', domain.errors > 0 && 'font-medium text-negative')}>
                  {domain.errors > 0 ? domain.errors.toLocaleString() : '—'}
                </td>
                <td className={cx('hidden px-2 py-1.5 text-right tabular-nums xl:table-cell', domain.inflight > 0 && 'font-medium text-caution')}>
                  {domain.inflight > 0 ? domain.inflight.toLocaleString() : '—'}
                </td>
                <td className="hidden px-2 py-1.5 text-right tabular-nums text-content-muted xl:table-cell">
                  {domain.success > 0 ? domain.success.toLocaleString() : '—'}
                </td>
                <td className="px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                  <div className="flex items-center gap-1">
                    <IconButton
                      icon={Play}
                      label={t('modules.start')}
                      busy={pending === `${domain.guid}:start`}
                      disabled={pending !== null || pulling || domain.active}
                      onClick={() => startAction(domain, 'start')}
                    />
                    <IconButton
                      icon={Stop}
                      label={t('modules.stop')}
                      busy={pending === `${domain.guid}:stop`}
                      disabled={pending !== null || pulling || !domain.active}
                      onClick={() => startAction(domain, 'stop')}
                    />
                    <IconButton
                      icon={ArrowsClockwise}
                      label={t('modules.restart')}
                      busy={pending === `${domain.guid}:restart`}
                      disabled={pending !== null || pulling || !domain.active}
                      onClick={() => startAction(domain, 'restart')}
                    />
                  </div>
                </td>
              </tr>
            ))}
            {visible.length === 0 && !loading && (
              <TableMessage colSpan={8}>{t('table.empty')}</TableMessage>
            )}
          </tbody>
        </DataTable>
      </div>

      <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-5 py-3">
        <span className="text-[11.5px] text-content-subtle">
          {t('api.domains.shown', { visible: visible.length, total: domains?.length ?? 0 })}
        </span>
        {selected.size > 0 && (
          <>
            <Badge tone="accent">{t('api.domains.selected', { count: selected.size })}</Badge>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>{t('action.deselect')}</Button>
            <span className="mx-1 h-5 w-px bg-line" />
            <Button size="sm" disabled={bulk !== null || pulling} onClick={() => void runBulk('start')}>
              {t('modules.start')}
            </Button>
            <Button size="sm" disabled={bulk !== null || pulling} onClick={() => setConfirmBulk('stop')}>
              {t('modules.stop')}
            </Button>
            <Button size="sm" disabled={bulk !== null || pulling} onClick={() => setConfirmBulk('restart')}>
              {t('modules.restart')}
            </Button>
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          {pulling && (
            <span className="text-[11.5px] text-content-subtle" title={t('api.pull.hint')}>
              {t('api.pull.progress', { current: progress?.current ?? 0, total: progress?.total ?? selected.size })}
            </span>
          )}
          <Button onClick={() => setAsking(null)} disabled={pulling} title={t('api.pull.allHint')}>
            {t('api.pull.all', { count: domains?.length ?? 0 })}
          </Button>
          <Button
            variant="primary"
            // Выбраны все домены — это и есть «забрать всё»: перечислять их незачем.
            onClick={() => setAsking(selected.size === domains?.length ? null : [...selected])}
            disabled={pulling || selected.size === 0}
          >
            {pulling
              ? <><Spinner className="size-4" /> {t('api.pull.running')}</>
              : t('api.pull.selected', { count: selected.size })}
          </Button>
        </div>
      </div>
      <Modal
        open={confirmBulk !== null}
        onClose={() => setConfirmBulk(null)}
        closeLabel={t('action.close')}
        title={confirmBulk === 'stop' ? t('domains.confirm.stopMany') : t('domains.confirm.restartMany')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmBulk(null)}>{t('action.cancel')}</Button>
            <Button variant="primary" onClick={() => confirmBulk && void runBulk(confirmBulk)}>
              {confirmBulk === 'stop' ? t('modules.stop') : t('modules.restart')}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[13px] leading-relaxed">
          <p className="text-content-muted">{t('domains.confirm.manyText', { count: selected.size })}</p>
          <Notice tone="warn">
            {t('domains.confirm.text')}
          </Notice>
        </div>
      </Modal>

      <Modal
        open={bulk !== null}
        onClose={() => bulk?.finished && setBulk(null)}
        closeLabel={t('action.close')}
        title={t('domains.bulk.title')}
        footer={
          <Button variant="primary" disabled={!bulk?.finished} onClick={() => setBulk(null)}>
            {t('action.close')}
          </Button>
        }
      >
        {bulk && (
          <div className="space-y-3 text-[13px] leading-relaxed">
            <div className="flex items-center gap-2">
              {!bulk.finished && <Spinner className="size-4" />}
              <span>{t('domains.bulk.progress', { done: bulk.done, total: bulk.total })}</span>
            </div>
            <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
              {bulk.results.map((item, index) => (
                <div
                  key={`${item.name}-${index}`}
                  className="flex items-center gap-2 border-b border-line/60 px-3 py-1.5 last:border-b-0"
                >
                  <span className={cx(
                    'size-1.5 shrink-0 rounded-full',
                    item.error ? 'bg-negative' : item.done ? 'bg-positive' : 'bg-caution',
                  )} />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  <span className="shrink-0 text-[11px] text-content-subtle">
                    {item.error ?? (item.done ? t('domains.bulk.ok') : t('domains.bulk.refused'))}
                  </span>
                </div>
              ))}
            </div>
            {bulk.finished && bulk.results.some((item) => !item.done) && (
              <Notice tone="warn">
                {t('domains.refusedMany')}
              </Notice>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        closeLabel={t('action.close')}
        title={confirm?.action === 'stop' ? t('domains.confirm.stop') : t('domains.confirm.restart')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>{t('action.cancel')}</Button>
            <Button variant="primary" onClick={() => confirm && void act(confirm.domain, confirm.action)}>
              {confirm?.action === 'stop' ? t('modules.stop') : t('modules.restart')}
            </Button>
          </>
        }
      >
        {confirm && (
          <div className="space-y-3 text-[13px] leading-relaxed">
            <code className="block break-all rounded bg-accent/12 px-2 py-1 font-mono text-accent-content">
              {confirm.domain.name}
            </code>
            <p className="text-content-muted">{t('domains.confirm.text')}</p>
          </div>
        )}
      </Modal>
      {/*
        Домены забирают ради двух разных вещей: чтобы поправить трассировку
        и чтобы просто снять копию конфигурации. Раньше выгрузка всегда
        открывала редактор, и второй случай приходилось доводить руками.
      */}
      <Modal
        open={asking !== undefined}
        onClose={() => setAsking(undefined)}
        closeLabel={t('action.close')}
        title={t('api.pull.intent.title')}
      >
        <p className="text-content-muted">{t('api.pull.intent.text')}</p>
        <div className="mt-4 flex flex-col gap-2">
          <IntentChoice
            title={t('api.pull.intent.edit')}
            text={t('api.pull.intent.edit.text')}
            onClick={() => { const guids = asking ?? null; setAsking(undefined); onPull(guids, 'edit') }}
          />
          <IntentChoice
            title={t('api.pull.intent.archive')}
            text={t('api.pull.intent.archive.text')}
            onClick={() => { const guids = asking ?? null; setAsking(undefined); onPull(guids, 'archive') }}
          />
        </div>
      </Modal>

    </ScreenBody>
  )
}

/** Один вариант ответа на «зачем забираем»: заголовок и строчка пояснения. */
function IntentChoice({ title, text, onClick }: { title: string; text: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'rounded-xl border border-line-strong bg-surface-2 px-4 py-3 text-left transition',
        'hover:border-accent/50 hover:bg-surface-3',
        FOCUS_RING,
      )}
    >
      <div className="text-[13px] font-semibold">{title}</div>
      <div className="mt-1 text-[11.5px] text-content-subtle">{text}</div>
    </button>
  )
}

/** Заголовок числовой колонки: клик меняет сортировку, стрелка показывает текущую. */
function SortColumn({ label, id, sort, onSort, align = 'right', className }: {
  label: string
  id: SortKey
  sort: SortKey
  onSort: (id: SortKey) => void
  align?: 'left' | 'right'
  className?: string
}) {
  return (
    <Th align={align} className={cx('px-2', className)}>
      <button
        type="button"
        onClick={() => onSort(id)}
        className={cx(
          'inline-flex items-center gap-1 rounded transition hover:text-content',
          FOCUS_RING,
          sort === id && 'text-accent-content',
        )}
      >
        {label}
        {sort === id && <CaretDown size={9} weight="bold" />}
      </button>
    </Th>
  )
}
