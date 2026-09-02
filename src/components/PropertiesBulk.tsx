import { useEffect, useMemo, useState } from 'react'

import { useI18n } from '../i18n'
import { apiSaveProperty, errorText } from '../lib/api'
import type { Connection, PropertyScope, SweepRow } from '../types'
import { Button, Modal, Notice, Segmented, Spinner, TextInput } from './ui'

/** Что заменяем: вхождение внутри значения или значение целиком. */
type Mode = 'part' | 'whole'

interface Props {
  open: boolean
  connection: Connection
  /** Отобранные строки — уже отфильтрованные и отмеченные на экране. */
  rows: SweepRow[]
  /** Чем заполнить поле поиска: обычно тем, что искали в таблице. */
  initialFrom?: string
  onClose: () => void
  onDone: () => void
}

/** Строка, которая действительно изменится, и её будущее значение. */
interface Change {
  row: SweepRow
  next: string
}

/**
 * Массовая замена значений констант.
 *
 * Смысл — день переезда: адрес смежной системы поменялся, и он записан
 * в двух сотнях доменов. Поштучная правка тут занимает вечер, а пропущенный
 * домен обнаруживается уже на проде.
 *
 * Замена показывается до записи построчно: «было → станет». Без предпросмотра
 * массовая правка живого стенда — это выстрел вслепую.
 */
export function PropertiesBulk({ open, connection, rows, initialFrom, onClose, onDone }: Props) {
  const { t } = useI18n()
  const [from, setFrom] = useState(initialFrom ?? '')
  const [to, setTo] = useState('')
  const [mode, setMode] = useState<Mode>('part')
  const [comment, setComment] = useState('')
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null)
  const [failures, setFailures] = useState<Array<{ row: SweepRow; error: string }>>([])
  const [finished, setFinished] = useState<number | null>(null)

  // Окно живёт рядом с таблицей и переживает закрытие, поэтому поле поиска
  // подхватывает искомое не при создании, а при каждом открытии: иначе
  // в него попадало то, что искали в самый первый раз, — то есть ничего.
  useEffect(() => {
    if (!open) return
    setFrom(initialFrom ?? '')
    setFinished(null)
    setFailures([])
  }, [open, initialFrom])

  /**
   * Скрытые значения сервер не отдаёт, поэтому заменять в них нечего:
   * запись подставила бы на месте секрета пустую строку.
   */
  const editable = useMemo(() => rows.filter((row) => !row.secured), [rows])
  const skipped = rows.length - editable.length

  const changes = useMemo<Change[]>(() => {
    if (!from) return []
    const found: Change[] = []
    for (const row of editable) {
      const value = row.value ?? ''
      if (!value.includes(from)) continue
      const next = mode === 'whole' ? to : value.split(from).join(to)
      if (next !== value) found.push({ row, next })
    }
    return found
  }, [editable, from, to, mode])

  const apply = async () => {
    setRunning({ done: 0, total: changes.length })
    setFailures([])
    const errors: Array<{ row: SweepRow; error: string }> = []
    let done = 0

    // Последовательно, а не пачками: это запись в живую шину, и порядок
    // «одна константа — один ответ» делает ошибку видимой сразу, а не
    // в куче одновременных отказов.
    for (const change of changes) {
      try {
        await apiSaveProperty(
          connection,
          scopeOf(change.row),
          { ...plain(change.row), value: change.next },
          false,
          comment.trim() || t('properties.replace.commentDefault'),
        )
        done += 1
      } catch (err) {
        errors.push({ row: change.row, error: errorText(err) })
      }
      setRunning({ done: done + errors.length, total: changes.length })
    }

    setFailures(errors)
    setFinished(done)
    setRunning(null)
    onDone()
  }

  const close = () => {
    setRunning(null)
    setFinished(null)
    setFailures([])
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={close}
      closeLabel={t('action.close')}
      title={t('properties.replace.title')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {finished === null ? t('action.cancel') : t('action.close')}
          </Button>
          {finished === null && (
            <Button
              variant="primary"
              className="min-w-36"
              disabled={changes.length === 0 || running !== null}
              onClick={() => void apply()}
            >
              {running ? <Spinner className="size-4" /> : t('properties.replace.apply', { count: changes.length })}
            </Button>
          )}
        </>
      }
    >
      {finished === null ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('properties.replace.from')} htmlFor="replace-from">
              <TextInput
                id="replace-from"
                value={from}
                className="font-mono"
                onChange={(event) => setFrom(event.target.value)}
              />
            </Field>
            <Field label={t('properties.replace.to')} htmlFor="replace-to">
              <TextInput
                id="replace-to"
                value={to}
                className="font-mono"
                onChange={(event) => setTo(event.target.value)}
              />
            </Field>
          </div>

          <Field label={t('properties.replace.mode')} htmlFor="replace-mode">
            <Segmented<Mode>
              ariaLabel={t('properties.replace.mode')}
              value={mode}
              onChange={setMode}
              options={[
                { id: 'part', label: t('properties.replace.mode.part') },
                { id: 'whole', label: t('properties.replace.mode.whole') },
              ]}
            />
          </Field>

          <Field label={t('properties.replace.comment')} htmlFor="replace-comment">
            <TextInput
              id="replace-comment"
              value={comment}
              placeholder={t('properties.replace.commentDefault')}
              onChange={(event) => setComment(event.target.value)}
            />
          </Field>

          {skipped > 0 && <Notice tone="warn" small>{t('properties.replace.secured')}</Notice>}

          {changes.length === 0 ? (
            <div className="rounded-lg border border-line px-3 py-2 text-[11.5px] text-content-subtle">
              {t('properties.replace.none')}
            </div>
          ) : (
            <div>
              <div className="mb-1.5 text-[11px] tracking-wide text-content-subtle">
                {t('properties.replace.preview', { count: changes.length })}
              </div>
              {/* Предпросмотр во всю высоту окна ни к чему: важно увидеть
                  образец замены, а не пролистать все двести строк. */}
              <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
                {changes.map((change) => (
                  <div
                    key={`${change.row.scope}/${change.row.key}`}
                    className="border-b border-line/60 px-2.5 py-1.5 last:border-b-0"
                  >
                    <div className="flex items-baseline gap-2 text-[11px] text-content-subtle">
                      <span className="truncate">{change.row.domain ?? change.row.scope}</span>
                      <span className="truncate font-mono">{change.row.key}</span>
                    </div>
                    {/* Строками, а не рядом: адреса длинные, и на две
                        колонки от них остаются одни начала — как раз та
                        часть, которая при замене хоста не меняется. */}
                    <div className="mt-0.5 font-mono text-[11.5px]">
                      <div className="flex gap-1.5">
                        <span className="shrink-0 text-content-subtle">−</span>
                        <span className="truncate text-content-muted line-through">{change.row.value}</span>
                      </div>
                      <div className="flex gap-1.5">
                        <span className="shrink-0 text-content-subtle">+</span>
                        <span className="truncate text-positive">{change.next}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {running && (
            <div className="text-[11.5px] text-content-subtle">
              {t('properties.replace.running', { current: running.done, total: running.total })}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <Notice tone={failures.length > 0 ? 'warn' : 'ok'} small>
            {t('properties.replace.done', { done: finished })}
            {failures.length > 0 && ` · ${t('properties.replace.failed', { count: failures.length })}`}
          </Notice>
          {failures.length > 0 && (
            <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
              {failures.map((failure) => (
                <div key={`${failure.row.scope}/${failure.row.key}`} className="border-b border-line/60 px-2.5 py-1.5 last:border-b-0">
                  <div className="flex items-baseline gap-2 text-[11px] text-content-subtle">
                    <span className="truncate">{failure.row.domain ?? failure.row.scope}</span>
                    <span className="truncate font-mono">{failure.row.key}</span>
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-negative">{failure.error}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

/** Строка обхода адресуется тем же, чем и обычная правка. */
export function scopeOf(row: SweepRow): PropertyScope {
  if (row.scope === 'application') return 'application'
  if (row.scope === 'broker') return 'broker'
  return { domain: row.scope }
}

/** Строка без полей обхода: серверу уходит обычная константа. */
export function plain(row: SweepRow) {
  return {
    key: row.key,
    value: row.value,
    secured: row.secured,
    vault: row.vault,
    empty: row.empty,
    description: row.description,
  }
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-[11px] tracking-wide text-content-subtle" htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  )
}
