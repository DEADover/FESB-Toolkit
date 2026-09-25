import { useCallback, useEffect, useRef, useState } from 'react'

import { ArrowClockwise, ArrowRight, CheckCircle, Question, Warning, WarningOctagon, type Icon } from '@phosphor-icons/react'

import { useI18n, type MessageKey } from '../i18n'
import { worstLevel, type HealthCheck, type HealthId, type HealthLevel } from '../lib/health'
import { loadHealth } from '../lib/healthLoad'
import type { Connection } from '../types'
import type { ScreenId } from './Sidebar'
import { Badge, cx, FOCUS_RING, IconButton, Spinner, Toggle, type Tone } from './ui'

const TITLE: Record<HealthId, MessageKey> = {
  modules: 'nav.api.modules',
  domains: 'nav.api.domains',
  routes: 'nav.api.routes',
  inflight: 'nav.api.inflight',
  queues: 'nav.api.queues',
  certificates: 'nav.api.certificates',
}

const OK_TEXT: Record<HealthId, MessageKey> = {
  modules: 'health.ok.modules',
  domains: 'health.ok.domains',
  routes: 'health.ok.routes',
  inflight: 'health.ok.inflight',
  queues: 'health.ok.queues',
  certificates: 'health.ok.certificates',
}

const FOUND_TEXT: Record<HealthId, MessageKey> = {
  modules: 'health.found.modules',
  domains: 'health.found.domains',
  routes: 'health.found.routes',
  inflight: 'health.found.inflight',
  queues: 'health.found.queues',
  certificates: 'health.found.certificates',
}

const LEVEL: Record<HealthLevel, { icon: Icon; color: string; tone: Tone; summary: MessageKey }> = {
  ok: { icon: CheckCircle, color: 'text-positive', tone: 'ok', summary: 'health.summary.ok' },
  warn: { icon: Warning, color: 'text-caution', tone: 'warn', summary: 'health.summary.warn' },
  error: { icon: WarningOctagon, color: 'text-negative', tone: 'danger', summary: 'health.summary.error' },
  unknown: { icon: Question, color: 'text-content-subtle', tone: 'neutral', summary: 'health.summary.unknown' },
}

/**
 * Сводка по стенду на первом экране.
 *
 * Шесть вопросов, которые иначе обходят по шести разделам: всё ли работает
 * из модулей, запущены ли домены, есть ли ошибки в СОПС, не висят ли обмены,
 * разбираются ли очереди, не истекают ли сертификаты. Строка с находкой
 * ведёт туда, где её разбирают; строка без находки остаётся тихой, чтобы
 * глаз цеплялся только за то, что требует внимания.
 */
export function StandHealth({ connection, onScreen, watching, onWatching }: {
  connection: Connection
  onScreen: (screen: ScreenId) => void
  /** Следить ли за стендом в фоне — с системными уведомлениями о новом. */
  watching: boolean
  onWatching: (value: boolean) => void
}) {
  const { t, language } = useI18n()
  const [checks, setChecks] = useState<HealthCheck[] | null>(null)
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const [loading, setLoading] = useState(false)
  // Сменили стенд, пока шла проверка, — ответ прежнего не должен лечь под новым адресом.
  const ticket = useRef(0)

  const check = useCallback(async () => {
    const mine = ++ticket.current
    setLoading(true)
    const fresh = await loadHealth(connection)
    if (mine !== ticket.current) return
    setChecks(fresh)
    setCheckedAt(new Date())
    setLoading(false)
  }, [connection])

  useEffect(() => {
    setChecks(null)
    void check()
  }, [check])

  const worst = checks ? worstLevel(checks) : null
  const time = checkedAt?.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })

  return (
    <section className="rounded-2xl border border-line bg-surface p-5">
      <div className="mb-4 flex items-center gap-3">
        <h2 className="text-[14px] font-semibold">{t('health.title')}</h2>
        {worst && <Badge tone={LEVEL[worst].tone}>{t(LEVEL[worst].summary)}</Badge>}
        <div className="flex-1" />
        {time && <span className="text-[11px] text-content-subtle">{t('health.checkedAt', { time })}</span>}
        <Toggle checked={watching} onChange={onWatching} label={t('watch.toggle')} title={t('watch.hint')} />
        <IconButton icon={ArrowClockwise} label={t('action.refresh')} busy={loading} disabled={loading} onClick={() => void check()} />
      </div>

      {checks ? (
        <div className={cx('grid gap-1.5 sm:grid-cols-2 transition-opacity', loading && 'opacity-60')}>
          {checks.map((item) => (
            <Row key={item.id} check={item} onOpen={() => onScreen(item.screen)} />
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2 py-6 text-[12px] text-content-subtle">
          <Spinner className="size-4" /> {t('health.loading')}
        </div>
      )}
    </section>
  )
}

function Row({ check, onOpen }: { check: HealthCheck; onOpen: () => void }) {
  const { t } = useI18n()
  const level = LEVEL[check.level]
  const quiet = check.level === 'ok'
  const text = check.level === 'unknown'
    ? t('health.unknown')
    : quiet
      ? t(OK_TEXT[check.id])
      // Красный у сертификатов — значит, какой-то уже истёк: «истекают» было бы неправдой.
      : t(check.id === 'certificates' && check.level === 'error' ? 'health.found.certificatesExpired' : FOUND_TEXT[check.id], { count: check.count })
  const more = check.count - check.samples.length

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cx(
        'group flex items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition',
        quiet ? 'border-transparent hover:bg-surface-2' : 'border-line bg-surface-2/60 hover:bg-surface-3',
        FOCUS_RING,
      )}
    >
      <level.icon size={18} weight={quiet ? 'regular' : 'fill'} className={cx('mt-px shrink-0', level.color)} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cx('text-[12.5px] font-medium', quiet ? 'text-content-muted' : 'text-content')}>{t(TITLE[check.id])}</span>
          <span className="truncate text-[12px] text-content-subtle">{text}</span>
        </span>
        {check.samples.length > 0 && (
          <span className="mt-1 block truncate font-mono text-[11px] text-content-subtle">
            {check.samples.join(', ')}{more > 0 && ` ${t('health.more', { count: more })}`}
          </span>
        )}
        {/* Почему не проверилось — чаще всего не хватает прав у учётной записи. */}
        {check.error && <span className="mt-1 block truncate text-[11px] text-content-subtle">{check.error}</span>}
      </span>
      <ArrowRight
        size={13}
        weight="bold"
        className="mt-1 shrink-0 text-content-subtle opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100"
      />
    </button>
  )
}
