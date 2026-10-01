import { useEffect, useMemo, useState } from 'react'

import { useI18n } from '../i18n'
import {
  currentValues, OPTION_GROUPS, optionValueLabel, TRACE_OPTIONS, validCount, type TraceOption,
} from '../lib/traceOptions'
import type { TraceBean } from '../types'
import { Button, cx, Modal, Segmented, Select, TextInput } from './ui'

interface Props {
  open: boolean
  /** Заданные значения: ключ → новое значение. Нет ключа — не менять. */
  value: Record<string, string>
  /** Выбранные объекты трассировки — по ним видно, что у них сейчас. */
  traces: TraceBean[]
  onChange: (next: Record<string, string>) => void
  onClose: () => void
}

const KEEP = 'keep'

/**
 * Дополнительные параметры объекта трассировки — те же, что в редакторе
 * домена FESB, и сгруппированы так же.
 *
 * Каждый параметр по умолчанию «не менять»: массовая правка трогает только
 * то, что задано явно, а у остальных объектов всё остаётся своё. Рядом
 * с параметром — что у выбранных объектов стоит сейчас: решение «поставить
 * всем Нет» принимают, видя, у скольких сейчас Да.
 *
 * Окно правит черновик: «Готово» отдаёт его панели, «Отмена» и Esc —
 * выбрасывают.
 */
export function TraceOptionsDialog({ open, value, traces, onChange, onClose }: Props) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<Record<string, string>>(value)

  // Черновик начинается с того, что уже задано на панели, — при каждом открытии.
  useEffect(() => {
    if (open) setDraft(value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const set = (key: string, next: string | null) => {
    setDraft((prev) => {
      const copy = { ...prev }
      if (next === null || next === '') delete copy[key]
      else copy[key] = next
      return copy
    })
  }

  const hasMemory = useMemo(() => traces.some((trace) => trace.kind === 'memory'), [traces])
  const invalid = TRACE_OPTIONS.some((item) => item.kind === 'count' && item.key in draft && !validCount(draft[item.key]))

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeLabel={t('action.close')}
      width="roomy"
      title={t('opt.title')}
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={() => setDraft({})} disabled={Object.keys(draft).length === 0}>
            {t('opt.reset')}
          </Button>
          <Button variant="ghost" onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" disabled={invalid} onClick={() => { onChange(draft); onClose() }}>{t('opt.done')}</Button>
        </>
      }
    >
      <div className="space-y-5">
        <p className="text-[12.5px] leading-relaxed text-content-muted">{t('opt.intro')}</p>
        {traces.length === 0 && (
          <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[12px] text-content-subtle">{t('opt.noSelection')}</p>
        )}

        {OPTION_GROUPS.map((group) => (
          <section key={group.id}>
            <h3 className="mb-1 text-[11px] font-semibold tracking-wide text-content-subtle uppercase">{t(group.label)}</h3>
            <div className="divide-y divide-line">
              {TRACE_OPTIONS.filter((item) => item.group === group.id).map((item) => (
                <OptionRow
                  key={item.key}
                  item={item}
                  value={draft[item.key] ?? null}
                  traces={traces}
                  showQueueOnly={item.queueOnly && hasMemory}
                  onChange={(next) => set(item.key, next)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </Modal>
  )
}

function OptionRow({ item, value, traces, showQueueOnly, onChange }: {
  item: TraceOption
  value: string | null
  traces: TraceBean[]
  showQueueOnly: boolean
  onChange: (next: string | null) => void
}) {
  const { t } = useI18n()
  const now = useMemo(() => currentValues(traces, item.key), [traces, item.key])
  const id = `trace-option-${item.key}`
  const bad = item.kind === 'count' && value !== null && !validCount(value)
  const total = now.reduce((sum, entry) => sum + entry.count, 0)
  /** Выбранное значение уже стоит у всех: правка по этому параметру ничего не сделает. */
  const settled = value !== null && now.length === 1 && now[0].value === value.trim()

  return (
    <div className="flex items-center gap-4 py-2.5">
      <div className="min-w-0 flex-1">
        {/* Подпись привязана к полю ввода; у переключателя и списка своё имя — `ariaLabel`. */}
        {item.kind === 'count' || item.kind === 'text'
          ? <label htmlFor={id} className="block text-[13px] leading-snug">{t(item.label)}</label>
          : <div className="text-[13px] leading-snug">{t(item.label)}</div>}
        {now.length > 0 && (
          <div className="mt-0.5 text-[11.5px] text-content-subtle">
            {/* Одно значение у всех — так и сказано; разные — каждое «у N из M». */}
            {now.length === 1
              ? t('opt.nowSame', { total, value: optionValueLabel(item.key, now[0].value, t) })
              : t('opt.now', {
                values: now
                  .map((entry) => t('opt.nowPart', { value: optionValueLabel(item.key, entry.value, t), count: entry.count, total }))
                  .join(', '),
              })}
          </div>
        )}
        {settled && <div className="mt-0.5 text-[11.5px] text-caution">{t('opt.nothingToChange')}</div>}
        {showQueueOnly && <div className="mt-0.5 text-[11.5px] text-content-subtle">{t('opt.queueOnly')}</div>}
        {bad && <div className="mt-0.5 text-[11.5px] text-negative">{t('opt.countHint')}</div>}
      </div>

      {(item.kind === 'flag' || item.kind === 'event') && (
        <Segmented
          ariaLabel={t(item.label)}
          value={value ?? KEEP}
          options={[
            { id: KEEP, label: t('opt.keep') },
            { id: 'true', label: t('opt.yes') },
            { id: 'false', label: t('opt.no') },
          ]}
          onChange={(next) => onChange(next === KEEP ? null : next)}
        />
      )}
      {item.kind === 'choice' && (
        <Select
          ariaLabel={t(item.label)}
          className="w-60"
          value={value ?? ''}
          options={[
            { id: '', label: t('opt.keep') },
            ...(item.choices ?? []).map((choice) => ({ id: choice, label: optionValueLabel(item.key, choice, t) })),
          ]}
          onChange={(next) => onChange(next || null)}
        />
      )}
      {(item.kind === 'count' || item.kind === 'text') && (
        // Ширину держит обёртка: у самого поля `w-full`, и классом поверх его не перебить.
        <div className="w-40 shrink-0">
          <TextInput
            id={id}
            className={cx('text-[12.5px]', bad && 'border-negative focus:border-negative focus:ring-negative/25')}
            inputMode={item.kind === 'count' ? 'numeric' : undefined}
            placeholder={t('opt.keep')}
            value={value ?? ''}
            aria-invalid={bad || undefined}
            title={item.kind === 'count' ? t('opt.countHint') : t('opt.textHint')}
            onChange={(event) => onChange(event.target.value.trim() === '' ? null : event.target.value)}
          />
        </div>
      )}
    </div>
  )
}
