import { useCallback, useEffect, useState } from 'react'

import { ArrowRight, CheckCircle, Copy, WarningCircle } from '@phosphor-icons/react'

import { useI18n, type MessageKey } from '../i18n'
import { apiDomains, apiProperties, apiSaveProperty, errorText } from '../lib/api'
import type { ConstantMove, ConstantScope, Direction, SkipReason, TransferPlan } from '../lib/transfer'
import type { Connection, PropertyRow, PropertyScope } from '../types'
import { Badge, Button, ButtonGlyph, cx, Modal, Notice } from './ui'

/** Стенд одной из сторон переноса. */
export interface TransferSide {
  name: string
  connection: Connection
  prod: boolean
}

interface Props {
  open: boolean
  onClose: (changed: boolean) => void
  plan: TransferPlan
  direction: Direction
  source: TransferSide
  target: TransferSide
  /** Домены копируются своим диалогом: там свой предпросмотр по СОПС. */
  onCopyDomains: (names: string[]) => void
}

type Outcome = { ok: true } | { ok: false; error: string }

const SKIP_TEXT: Record<SkipReason, MessageKey> = {
  nothingThere: 'transfer.skip.nothingThere',
  domainsOneWay: 'transfer.skip.domainsOneWay',
}

/**
 * Перенос констант, найденных сравнением.
 *
 * Сначала — что именно запишется и что там сейчас, и только потом запись.
 * Константы пишутся по одной: чужая ошибка на одной не отменяет остальные,
 * и по каждой видно, чем кончилось. Комментарий к правке называет исходный
 * стенд — в аудите целевого будет видно, откуда пришло значение.
 */
export function TransferDialog({ open, onClose, plan, direction, source, target, onCopyDomains }: Props) {
  const { t } = useI18n()
  const [running, setRunning] = useState(false)
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setOutcomes(null)
    setError(null)
  }, [open])

  const scopeLabel = useCallback((scope: ConstantScope) => {
    if (scope === 'application') return t('properties.scope.application')
    if (scope === 'broker') return t('properties.scope.broker')
    return scope.domainName
  }, [t])

  const run = useCallback(async () => {
    setRunning(true)
    setError(null)
    try {
      // Доменный уровень адресуется guid целевого стенда: у того же домена
      // на другом стенде он свой.
      const needsDomains = plan.constants.some((move) => typeof move.scope === 'object')
      const guids = new Map<string, string>()
      if (needsDomains) {
        for (const domain of await apiDomains(target.connection)) guids.set(domain.name, domain.guid)
      }
      const existing = new Map<string, PropertyRow[]>()
      const comment = t('transfer.comment', { source: source.name })
      const results: Outcome[] = []
      for (const move of plan.constants) {
        results.push(await write(move))
        setOutcomes([...results])
      }

      async function write(move: ConstantMove): Promise<Outcome> {
        let scope: PropertyScope
        if (typeof move.scope === 'object') {
          const guid = guids.get(move.scope.domainName)
          if (!guid) return { ok: false, error: t('transfer.noDomain', { domain: move.scope.domainName }) }
          scope = { domain: guid }
        } else {
          scope = move.scope
        }
        try {
          // Список уровня перечитывается перед записью: константу могли
          // завести, пока смотрели на сравнение, а описание у неё своё —
          // перезаписывать его пустым незачем.
          const key = typeof scope === 'object' ? scope.domain : scope
          if (!existing.has(key)) existing.set(key, await apiProperties(target.connection, scope))
          const there = existing.get(key)!.find((row) => row.key === move.key)
          const row: PropertyRow = there
            ? { ...there, value: move.value, empty: move.value === '' }
            : { key: move.key, value: move.value, secured: false, vault: false, empty: move.value === '', description: null }
          await apiSaveProperty(target.connection, scope, row, !there, comment)
          return { ok: true }
        } catch (err) {
          return { ok: false, error: errorText(err) }
        }
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setRunning(false)
    }
  }, [plan, source.name, target.connection, t])

  const done = outcomes !== null && outcomes.length === plan.constants.length && !running
  const failed = outcomes?.filter((item) => !item.ok).length ?? 0

  const footer = done ? (
    <Button variant="primary" onClick={() => onClose(true)}>{t('action.close')}</Button>
  ) : (
    <>
      <Button variant="ghost" disabled={running} onClick={() => onClose(false)}>{t('action.cancel')}</Button>
      {plan.constants.length > 0 && (
        <Button variant={target.prod ? 'danger' : 'primary'} className="min-w-44" disabled={running} onClick={() => void run()}>
          <ButtonGlyph busy={running}><ArrowRight size={14} weight="bold" /></ButtonGlyph>
          {t('transfer.run', { count: plan.constants.length })}
        </Button>
      )}
    </>
  )

  return (
    <Modal
      open={open}
      onClose={() => !running && onClose(outcomes !== null)}
      closeLabel={t('action.close')}
      title={t('transfer.title', { target: target.name })}
      width="wide"
      footer={footer}
    >
      <div className="space-y-3 text-[13px] leading-relaxed">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={direction === 'toOther' ? 'accent' : 'neutral'}>{source.name}</Badge>
          <ArrowRight size={14} className="text-content-subtle" />
          <Badge tone={target.prod ? 'danger' : direction === 'toOther' ? 'neutral' : 'accent'}>{target.name}</Badge>
        </div>

        {target.prod && !done && <Notice tone="warn">{t('transfer.prod')}</Notice>}
        {error && <Notice tone="danger">{error}</Notice>}
        {done && (
          <Notice tone={failed > 0 ? 'warn' : 'ok'}>
            {failed > 0 ? t('transfer.done.partly', { failed, total: plan.constants.length }) : t('transfer.done', { count: plan.constants.length })}
          </Notice>
        )}

        {plan.constants.length > 0 && (
          <div className="max-h-80 overflow-auto rounded-lg border border-line">
            <table className="w-full table-fixed text-[12px]">
              <colgroup>
                <col className="w-8" />
                <col className="w-40" />
                <col className="w-56" />
                <col />
                <col />
              </colgroup>
              <thead className="sticky top-0 bg-surface-2 text-left text-[11px] text-content-subtle">
                <tr>
                  <th />
                  <th className="px-2 py-1.5 font-medium">{t('compare.where')}</th>
                  <th className="px-2 py-1.5 font-medium">{t('compare.name')}</th>
                  <th className="px-2 py-1.5 font-medium">{t('transfer.now')}</th>
                  <th className="px-2 py-1.5 font-medium">{t('transfer.will')}</th>
                </tr>
              </thead>
              <tbody>
                {plan.constants.map((move, index) => {
                  const outcome = outcomes?.[index]
                  return (
                    <tr key={`${scopeLabel(move.scope)}/${move.key}`} className="border-t border-line/60 align-top">
                      <td className="px-2 py-1.5">
                        {outcome?.ok && <CheckCircle size={15} weight="fill" className="text-positive" />}
                        {outcome && !outcome.ok && <WarningCircle size={15} weight="fill" className="text-negative" />}
                      </td>
                      <td className="truncate px-2 py-1.5 text-content-muted">{scopeLabel(move.scope)}</td>
                      <td className="truncate px-2 py-1.5 font-medium" title={move.key}>
                        {move.key}
                        {outcome && !outcome.ok && <div className="whitespace-normal text-[11px] font-normal text-negative">{outcome.error}</div>}
                      </td>
                      <td className={cx('truncate px-2 py-1.5 font-mono text-[11.5px]', move.current === null && 'text-content-subtle')} title={move.current ?? undefined}>
                        {move.current === null ? t('transfer.absent') : move.current || '""'}
                      </td>
                      <td className="truncate px-2 py-1.5 font-mono text-[11.5px]" title={move.value}>{move.value || '""'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {plan.domains.length > 0 && (
          <div className="rounded-lg border border-line bg-surface-2/60 p-3">
            <p className="text-content-muted">{t('transfer.domains', { count: plan.domains.length })}</p>
            <p className="mt-1 font-mono text-[11.5px] text-content-subtle">{plan.domains.join(', ')}</p>
            <Button className="mt-2" onClick={() => onCopyDomains(plan.domains)}>
              <Copy size={14} weight="bold" /> {t('transfer.copyDomains')}
            </Button>
          </div>
        )}

        {plan.skipped.length > 0 && (
          <div className="text-[12px] text-content-subtle">
            <p>{t('transfer.skipped', { count: plan.skipped.length })}</p>
            <ul className="mt-1 list-disc pl-5">
              {[...new Set(plan.skipped.map((item) => item.reason))].map((reason) => (
                <li key={reason}>{t(SKIP_TEXT[reason])}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  )
}
