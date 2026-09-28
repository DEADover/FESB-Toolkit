import { useCallback, useMemo, useState, type FormEvent, type ReactNode } from 'react'

import { ArrowRight, Footprints, ListDashes, MagnifyingGlass, Queue } from '@phosphor-icons/react'

import { useI18n, type MessageKey } from '../i18n'
import { apiFindKey, errorText, onApiProgress } from '../lib/api'
import { inErrorQueue, lastSeen, outcomeOf, queuePlaces, routesOf, type Outcome } from '../lib/keyTrace'
import type { ApiProgress, Connection, KeyQueueHit, KeyTrace, ManagerKind, ServerInfo } from '../types'
import { ErrorBar, NotConnected, Panel, ScreenBody, StatsBar } from './ApiShell'
import {
  Badge, Button, ButtonGlyph, cx, DataTable, EmptyState, Highlight, Notice, rowClick, SearchInput, Stat, Th, THead, type Tone,
} from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  onGoToConnection: () => void
  onOpenRoute: (domainGuid: string, route: string) => void
  onOpenQueue: (manager: { kind: ManagerKind; id: string }, queue: string) => void
  /** Журнал сервера с ключом в поиске. */
  onOpenLog: (key: string) => void
  onOpenInflight: () => void
}

const OUTCOME_LABEL: Record<Outcome, MessageKey> = {
  deadLetter: 'keySearch.outcome.deadLetter',
  running: 'keySearch.outcome.running',
  failed: 'keySearch.outcome.failed',
  waiting: 'keySearch.outcome.waiting',
  done: 'keySearch.outcome.done',
  notFound: 'keySearch.outcome.notFound',
}
const OUTCOME_TONE: Record<Outcome, Tone> = {
  deadLetter: 'danger',
  failed: 'danger',
  running: 'warn',
  waiting: 'accent',
  done: 'ok',
  notFound: 'neutral',
}

const PHASE_LABEL: Record<string, MessageKey> = {
  logs: 'keySearch.phase.logs',
  inflight: 'keySearch.phase.inflight',
  queues: 'keySearch.phase.queues',
}

/** `2026-09-28T10:00:03.120` → `2026-09-28 10:00:03`. */
const time = (value: string | null) => value?.replace('T', ' ').slice(0, 19) ?? '—'

/**
 * Поиск обмена по бизнес-ключу.
 *
 * При разборе инцидента известен номер заказа или ИНН, а не идентификатор
 * обмена. Здесь ключ ищется разом в журналах, среди незавершённых обменов
 * и в сообщениях очередей — и сверху сразу ответ: где обмен сейчас и чем
 * закончился. Ниже — на чём этот ответ основан.
 */
export function KeySearchScreen({ connection, server, onGoToConnection, onOpenRoute, onOpenQueue, onOpenLog, onOpenInflight }: Props) {
  const { t } = useI18n()
  const [key, setKey] = useState('')
  const [trace, setTrace] = useState<KeyTrace | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ApiProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  const needle = key.trim()
  const tooShort = needle.length > 0 && needle.length < 3

  const search = useCallback(async (event?: FormEvent) => {
    event?.preventDefault()
    if (!connection || needle.length < 3 || busy) return
    setBusy(true)
    setError(null)
    setProgress(null)
    // Ответ по прошлому ключу убирается сразу: пока идёт новый поиск, он
    // выглядел бы ответом на новый.
    setTrace(null)
    const stop = await onApiProgress(setProgress)
    try {
      setTrace(await apiFindKey(connection, needle))
    } catch (err) {
      setError(errorText(err))
    } finally {
      void stop()
      setBusy(false)
      setProgress(null)
    }
  }, [connection, needle, busy])

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  return (
    <ScreenBody>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => void search(event)}>
        <SearchInput
          className="min-w-72 flex-1"
          value={key}
          placeholder={t('keySearch.placeholder')}
          onChange={setKey}
          clearLabel={t('action.clearSearch')}
          autoFocus
        />
        <Button type="submit" variant="primary" className="min-w-36" disabled={busy || needle.length < 3}>
          <ButtonGlyph busy={busy}><MagnifyingGlass size={14} weight="bold" /></ButtonGlyph>
          {t('keySearch.run')}
        </Button>
      </form>

      {tooShort && <p className="text-[11.5px] text-content-subtle">{t('keySearch.tooShort')}</p>}
      {busy && (
        <p className="text-[11.5px] tabular-nums text-content-subtle">
          {progress?.phase === 'queues' && progress.total > 0
            ? t('keySearch.phase.queuesCount', { current: progress.current, total: progress.total })
            : t(PHASE_LABEL[progress?.phase ?? 'logs'] ?? 'keySearch.phase.logs')}
        </p>
      )}
      <ErrorBar error={error} />

      {trace ? (
        <Result
          trace={trace}
          onOpenRoute={onOpenRoute}
          onOpenQueue={onOpenQueue}
          onOpenLog={onOpenLog}
          onOpenInflight={onOpenInflight}
        />
      ) : !busy && (
        <EmptyState icon={Footprints} title={t('keySearch.intro.title')} text={t('keySearch.intro.text')} />
      )}
    </ScreenBody>
  )
}

function Result({ trace, onOpenRoute, onOpenQueue, onOpenLog, onOpenInflight }: {
  trace: KeyTrace
  onOpenRoute: Props['onOpenRoute']
  onOpenQueue: Props['onOpenQueue']
  onOpenLog: Props['onOpenLog']
  onOpenInflight: Props['onOpenInflight']
}) {
  const { t } = useI18n()
  const outcome = outcomeOf(trace)
  const routes = useMemo(() => routesOf(trace.logs), [trace.logs])
  const places = useMemo(() => queuePlaces(trace.queues), [trace.queues])
  const seen = lastSeen(trace)
  const openQueue = (hit: Pick<KeyQueueHit, 'kind' | 'manager' | 'queue'>) => onOpenQueue({ kind: hit.kind, id: hit.manager }, hit.queue)

  const coverage = (
    <div className="space-y-2">
      <p className="text-[11.5px] text-content-subtle">
        {t('keySearch.checked', { queues: trace.queuesChecked, messages: trace.messagesChecked })}
        {trace.bodiesSkipped > 0 && ` ${t('keySearch.bodiesSkipped', { count: trace.bodiesSkipped })}`}
        {trace.queuesTruncated.length > 0 && ` ${t('keySearch.truncated', { queues: trace.queuesTruncated.join(', ') })}`}
      </p>
      {trace.problems.length > 0 && (
        <Notice tone="warn" small>
          {t('keySearch.problems')}
          <ul className="mt-1 list-disc pl-4">
            {trace.problems.map((problem) => <li key={problem} className="break-all">{problem}</li>)}
          </ul>
        </Notice>
      )}
    </div>
  )

  if (outcome === 'notFound') {
    return (
      <>
        <EmptyState icon={Footprints} title={t('keySearch.notFound.title', { key: trace.key })} text={t('keySearch.notFound.text')} />
        {coverage}
      </>
    )
  }

  const place = places[0]
  const flying = trace.inflight[0]
  const lastRoute = routes[routes.length - 1]
  const failedRoute = routes.find((visit) => visit.errors > 0)
  const verdict = (() => {
    switch (outcome) {
      case 'deadLetter':
      case 'waiting':
        return t(outcome === 'deadLetter' ? 'keySearch.verdict.deadLetter' : 'keySearch.verdict.waiting', { queue: place.queue, broker: place.broker })
      case 'running':
        return t('keySearch.verdict.running', { route: flying.at ?? flying.route, domain: flying.domain })
      case 'failed':
        return t('keySearch.verdict.failed', { route: failedRoute?.route ?? '—', time: time(failedRoute?.last ?? null) })
      default:
        return t('keySearch.verdict.done', { count: routes.length, route: lastRoute?.route ?? '—', time: time(seen) })
    }
  })()
  const firstQueueHit = place && trace.queues.find((hit) => hit.broker === place.broker && hit.queue === place.queue)

  return (
    <div className="flex flex-col gap-3">
      <Panel>
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <Badge tone={OUTCOME_TONE[outcome]}>
            {t(OUTCOME_LABEL[outcome])}
          </Badge>
          <p className="min-w-0 flex-1 text-[13px] leading-relaxed">{verdict}</p>
          {(outcome === 'deadLetter' || outcome === 'waiting') && firstQueueHit && (
            <Button size="sm" onClick={() => openQueue(firstQueueHit)}>
              <Queue size={13} weight="bold" /> {t('keySearch.openQueue')}
            </Button>
          )}
          {outcome === 'running' && (
            <Button size="sm" onClick={onOpenInflight}>{t('keySearch.openInflight')} <ArrowRight size={13} weight="bold" /></Button>
          )}
        </div>
      </Panel>

      <StatsBar>
        <Stat label={t('keySearch.stat.routes')} value={routes.length} />
        <Stat label={t('keySearch.stat.logs')} value={trace.logsLimited ? `${trace.logs.length}+` : trace.logs.length} />
        <Stat label={t('keySearch.stat.queues')} value={trace.queues.length} tone={places.some((item) => item.error) ? 'danger' : undefined} />
        <Stat label={t('keySearch.stat.inflight')} value={trace.inflight.length} tone={trace.inflight.length > 0 ? 'warn' : undefined} />
        <Stat label={t('keySearch.stat.lastSeen')} value={<span className="text-[13px]">{time(seen)}</span>} />
      </StatsBar>

      {routes.length > 0 && (
        <Section title={t('keySearch.section.routes')} hint={t('keySearch.section.routes.hint')}>
          <DataTable>
            <colgroup>
              <col className="w-10" />
              <col />
              <col className="w-24" />
              <col className="w-80" />
            </colgroup>
            <THead>
              <Th>#</Th>
              <Th>{t('keySearch.col.route')}</Th>
              <Th align="right">{t('keySearch.col.lines')}</Th>
              <Th>{t('keySearch.col.when')}</Th>
            </THead>
            <tbody>
              {routes.map((visit, index) => (
                <tr
                  key={`${visit.domain}/${visit.route}`}
                  onClick={visit.domainGuid ? rowClick(() => onOpenRoute(visit.domainGuid!, visit.route)) : undefined}
                  className={cx('border-b border-line/60', visit.domainGuid && 'cursor-pointer hover:bg-surface-2')}
                  title={visit.domainGuid ? t('keySearch.openRoute') : undefined}
                >
                  <td className="px-3 py-1.5 tabular-nums text-content-subtle">{index + 1}</td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{visit.route}</span>
                      {visit.errors > 0 && <Badge tone="danger">{t('keySearch.errors', { count: visit.errors })}</Badge>}
                    </div>
                    <div className="truncate text-[10.5px] text-content-subtle">{visit.domain}</div>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{visit.lines}</td>
                  <td className="px-3 py-1.5 font-mono text-[11px] text-content-muted">
                    {visit.first === visit.last ? time(visit.first) : `${time(visit.first)} — ${time(visit.last).slice(11)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Section>
      )}

      {trace.queues.length > 0 && (
        <Section title={t('keySearch.section.queues')}>
          <DataTable>
            <colgroup>
              <col className="w-64" />
              <col />
              <col className="w-44" />
            </colgroup>
            <THead>
              <Th>{t('keySearch.col.queue')}</Th>
              <Th>{t('keySearch.col.found')}</Th>
              <Th>{t('logs.time')}</Th>
            </THead>
            <tbody>
              {trace.queues.map((hit) => (
                <tr
                  key={`${hit.broker}/${hit.queue}/${hit.messageId}`}
                  onClick={rowClick(() => openQueue(hit))}
                  className="cursor-pointer border-b border-line/60 align-top hover:bg-surface-2"
                  title={t('keySearch.openQueue')}
                >
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-[12px]">{hit.queue}</span>
                      {inErrorQueue(hit) && <Badge tone="danger">{t('queues.errorQueue')}</Badge>}
                    </div>
                    <div className="truncate text-[10.5px] text-content-subtle">
                      {hit.broker}{hit.originalQueue && hit.originalQueue !== hit.queue ? ` · ${t('queues.origin.value', { queue: hit.originalQueue })}` : ''}
                    </div>
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="truncate font-mono text-[11px] text-content-muted" title={hit.excerpt}>
                      <Highlight text={hit.excerpt} needle={trace.key} />
                    </div>
                    <div className="truncate font-mono text-[10.5px] text-content-subtle" title={hit.messageId}>
                      {hit.messageId} · {t(hit.inBody ? 'keySearch.inBody' : 'keySearch.inHeaders')}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[11px] text-content-subtle">{time(hit.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Section>
      )}

      {trace.inflight.length > 0 && (
        <Section title={t('keySearch.section.inflight')} hint={t('keySearch.section.inflight.hint')}>
          <DataTable>
            <colgroup>
              <col />
              <col className="w-64" />
              <col className="w-72" />
            </colgroup>
            <THead>
              <Th>{t('keySearch.col.route')}</Th>
              <Th>{t('inflight.node')}</Th>
              <Th>{t('keySearch.col.exchange')}</Th>
            </THead>
            <tbody>
              {trace.inflight.map((exchange) => (
                <tr key={exchange.id} onClick={rowClick(onOpenInflight)} className="cursor-pointer border-b border-line/60 hover:bg-surface-2">
                  <td className="px-3 py-1.5">
                    <div className="truncate font-medium">{exchange.at ?? exchange.route}</div>
                    <div className="truncate text-[10.5px] text-content-subtle">{exchange.domain}</div>
                  </td>
                  <td className="truncate px-3 py-1.5 text-content-muted">{exchange.node ?? '—'}</td>
                  <td className="truncate px-3 py-1.5 font-mono text-[11px] text-content-subtle" title={exchange.id}>{exchange.id}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Section>
      )}

      {trace.logs.length > 0 && (
        <Section
          title={t('keySearch.section.logs')}
          hint={trace.logsLimited ? t('keySearch.logsLimited') : trace.exchangeIds.length > 0 ? t('keySearch.followed', { count: trace.exchangeIds.length }) : undefined}
          action={(
            <Button size="sm" variant="ghost" onClick={() => onOpenLog(trace.key)}>
              <ListDashes size={13} weight="bold" /> {t('keySearch.openLog')}
            </Button>
          )}
        >
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
              <Th>{t('keySearch.col.route')}</Th>
              <Th>{t('logs.message')}</Th>
            </THead>
            <tbody>
              {trace.logs.map((hit, index) => {
                const level = hit.level?.toUpperCase() ?? ''
                const text = hit.route ? hit.message.replace(/^\s*\[[^\]]*\] - /, '') : hit.message
                return (
                  <tr key={index} className={cx('border-b border-line/60 align-top', hit.byExchange && 'text-content-muted')}>
                    <td className="px-3 py-1.5 font-mono text-[11px] text-content-subtle">{time(hit.timestamp)}</td>
                    <td className="px-3 py-1.5">
                      <Badge tone={level === 'ERROR' || level === 'FATAL' ? 'danger' : level === 'WARN' ? 'warn' : 'neutral'}>{level || '—'}</Badge>
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="truncate text-[12px]">{hit.route?.route ?? '—'}</div>
                      {hit.route && <div className="truncate text-[10.5px] text-content-subtle">{hit.route.domain}</div>}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="line-clamp-2 whitespace-pre-wrap break-all font-mono text-[11px]" title={hit.message}>
                        <Highlight text={text} needle={trace.key} />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </DataTable>
        </Section>
      )}

      {coverage}
    </div>
  )
}

function Section({ title, hint, action, children }: { title: string; hint?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Panel>
      <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-3 py-2">
        <span className="text-[11px] font-semibold tracking-wide text-content-subtle">{title}</span>
        {hint && <span className="truncate text-[11px] text-content-subtle">· {hint}</span>}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </Panel>
  )
}
