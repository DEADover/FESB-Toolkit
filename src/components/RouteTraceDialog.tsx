import { useEffect, useMemo, useState } from 'react'

import { useI18n } from '../i18n'
import { apiDomainTraceBeans, errorText } from '../lib/api'
import { beanChoices, beansByDomain, planRouteTrace, type RoutePlan } from '../lib/routeTrace'
import type { Connection, DomainTraceBeans, RouteSummary, RouteTraceChange } from '../types'
import { Button, Modal, Notice, Segmented, Select, Spinner } from './ui'

interface Props {
  open: boolean
  connection: Connection
  /** Отмеченные СОПС. */
  rows: RouteSummary[]
  onClose: () => void
  onApply: (change: RouteTraceChange, plan: RoutePlan[]) => void
}

type Switch = 'keep' | 'on' | 'off'
/** `''` — не менять, `DEFAULT` — по умолчанию домена, остальное — имя объекта. */
const DEFAULT = '\u0000default'

/**
 * Трассировка отмеченных СОПС: включить, выключить, сменить объект.
 *
 * Объекты трассировки у каждого домена свои, а в API их списка нет —
 * окно читает их из выгрузки затронутых доменов. Так оно не даст назначить
 * СОПС объект, которого в его домене нет, и заранее говорит, сколько СОПС
 * изменится, сколько уже такие и сколько пропустится.
 */
export function RouteTraceDialog({ open, connection, rows, onClose, onApply }: Props) {
  const { t } = useI18n()
  const [mode, setMode] = useState<Switch>('keep')
  const [object, setObject] = useState('')
  const [beans, setBeans] = useState<DomainTraceBeans[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const guids = useMemo(() => [...new Set(rows.map((row) => row.domainGuid).filter(Boolean))], [rows])

  useEffect(() => {
    if (!open) return
    setMode('keep')
    setObject('')
    setBeans(null)
    setError(null)
    setLoading(true)
    let cancelled = false
    apiDomainTraceBeans(connection, guids)
      .then((list) => { if (!cancelled) setBeans(list) })
      .catch((err) => { if (!cancelled) setError(errorText(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // Список доменов меняется вместе с открытием окна — читаем один раз на открытие.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const change = useMemo<RouteTraceChange>(() => ({
    enabled: mode === 'keep' ? null : mode === 'on',
    config: object === '' ? null : object === DEFAULT ? '' : object,
  }), [mode, object])

  const known = useMemo(() => (beans ? beansByDomain(beans) : null), [beans])
  const plan = useMemo(() => planRouteTrace(rows, change, known), [rows, change, known])
  const counts = useMemo(() => ({
    change: plan.filter((item) => item.kind === 'change').length,
    unchanged: plan.filter((item) => item.kind === 'unchanged').length,
    missing: plan.filter((item) => item.kind === 'missing').length,
    started: plan.filter((item) => item.kind === 'change' && item.row.state === 'Started').length,
  }), [plan])
  const choices = useMemo(() => (beans ? beanChoices(beans) : []), [beans])
  const nothingAsked = change.enabled === null && change.config === null

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeLabel={t('action.close')}
      width="roomy"
      title={t('routeTrace.title', { count: rows.length })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('action.cancel')}</Button>
          <Button
            variant="primary"
            disabled={nothingAsked || counts.change === 0 || (change.config !== null && change.config !== '' && !known)}
            onClick={() => onApply(change, plan)}
          >
            {t('routeTrace.apply', { count: counts.change })}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <div className="flex-1 text-[13px]">{t('routeTrace.state')}</div>
          <Segmented<Switch>
            ariaLabel={t('routeTrace.state')}
            value={mode}
            onChange={setMode}
            options={[
              { id: 'keep', label: t('opt.keep') },
              { id: 'on', label: t('routeTrace.on') },
              { id: 'off', label: t('routeTrace.off') },
            ]}
          />
        </div>

        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-[13px]">{t('routeTrace.object')}</div>
            <div className="mt-0.5 text-[11.5px] text-content-subtle">
              {loading
                ? <span className="inline-flex items-center gap-1.5"><Spinner className="size-3" /> {t('routeTrace.loading', { count: guids.length })}</span>
                : t('routeTrace.objectHint')}
            </div>
          </div>
          <Select
            ariaLabel={t('routeTrace.object')}
            className="w-72"
            value={object}
            onChange={setObject}
            options={[
              { id: '', label: t('opt.keep') },
              { id: DEFAULT, label: t('routeTrace.default') },
              ...choices.map((choice) => ({
                id: choice.name,
                label: choice.name,
                hint: t('routeTrace.inDomains', { count: choice.domains, total: guids.length }),
              })),
            ]}
          />
        </div>

        {error && <Notice tone="warn" small>{t('routeTrace.beansFailed', { error })}</Notice>}

        {!nothingAsked && (
          <ul className="list-disc space-y-1 pl-4 text-[12.5px] text-content-muted marker:text-content-subtle">
            <li>{t('routeTrace.plan.change', { count: counts.change })}</li>
            {counts.unchanged > 0 && <li>{t('routeTrace.plan.unchanged', { count: counts.unchanged })}</li>}
            {counts.missing > 0 && <li className="text-caution">{t('routeTrace.plan.missing', { count: counts.missing })}</li>}
          </ul>
        )}

        <p className="text-[12px] leading-relaxed text-content-subtle">{t('routeTrace.how')}</p>
        {counts.started > 0 && <Notice tone="warn" small>{t('routeTrace.plan.started', { count: counts.started })}</Notice>}
      </div>
    </Modal>
  )
}
