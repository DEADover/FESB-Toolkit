import { useEffect, useRef, useState } from 'react'

import { useI18n, type MessageKey } from '../i18n'
import { onApiProgress, onApplyProgress, onArchiveProgress, onExtractProgress, onScanProgress } from '../lib/api'
import { formatEta } from '../lib/format'
import { cx, Spinner } from './ui'

/**
 * Что сейчас делает приложение — в шапке, рядом с переключателем стенда.
 *
 * Долгих действий много, и раньше каждое отчитывалось у себя: выгрузка
 * доменов — на экране доменов, сборка архива — в кнопке, чтение папки —
 * пустым экраном. Стоило уйти на соседний экран, и работа шла вслепую.
 *
 * Все они и так шлют события с ходом работы, поэтому полоса не спрашивает
 * экраны ни о чём: слушает эти события и показывает последнее.
 */
interface Job {
  label: MessageKey
  current: number
  total: number
  /** Когда работа началась — от этого считается оставшееся время. */
  startedAt: number
  /** Когда пришла последняя весточка: по молчанию понятно, что всё. */
  seenAt: number
}

/** Работу короче этого никто не заметит, а полоса успеет мигнуть. */
const SHOW_AFTER = 400
/** Досчитала до конца — показываем полную полосу и убираем. */
const KEEP_DONE = 700
/** Событий нет так долго — работа кончилась или сорвалась. */
const FORGET_SILENT = 5000

export function JobStatus() {
  const { t } = useI18n()
  const [job, setJob] = useState<Job | null>(null)
  const [shown, setShown] = useState(false)
  /** Часы для обратного отсчёта: он должен убывать и между событиями. */
  const [now, setNow] = useState(() => Date.now())
  const active = job !== null
  // Сторож живёт вне отрисовки, поэтому о показанном узнаёт из ref.
  const visible = useRef(false)
  visible.current = shown
  // Держим текущее в ref: обработчики событий подписываются один раз
  // и не должны переподписываться на каждое изменение.
  const current = useRef<Job | null>(null)

  useEffect(() => {
    const report = (label: MessageKey, done: number, total: number) => {
      const now = Date.now()
      const previous = current.current
      const next: Job = {
        label,
        current: done,
        total,
        // Работа та же — время начала сохраняем, иначе оценка обнулялась бы
        // на каждом событии.
        startedAt: previous && previous.label === label ? previous.startedAt : now,
        seenAt: now,
      }
      current.current = next
      setJob(next)
    }

    const stops = [
      onScanProgress((progress) =>
        report(progress.phase === 'walk' ? 'job.scan.walk' : 'job.scan.read', progress.current, progress.total)),
      onExtractProgress((progress) => report('job.extract', progress.current, progress.total)),
      onArchiveProgress((progress) => report('job.archive', progress.current, progress.total)),
      onApplyProgress((progress) => report('job.apply', progress.current, progress.total)),
      onApiProgress((progress) => report(API_LABEL[progress.phase], progress.current, progress.total)),
    ]
    return () => { for (const stop of stops) void stop.then((off) => off()) }
  }, [])

  // Появление с задержкой, уборка и обратный отсчёт — всё по времени,
  // поэтому считает один тикающий сторож, а не три обработчика событий.
  // События приходят редко, а оценка должна убывать между ними.
  useEffect(() => {
    if (!active) return
    const forget = () => { current.current = null; setJob(null); setShown(false) }

    const tick = setInterval(() => {
      const latest = current.current
      if (!latest) return
      const at = Date.now()
      setNow(at)

      const finished = latest.total > 0 && latest.current >= latest.total
      // Работа кончилась раньше, чем полоса успела появиться, — и не надо.
      if (finished && !visible.current) return forget()
      if (finished && at - latest.seenAt >= KEEP_DONE) return forget()
      // Вестей нет так долго, что работа явно кончилась или сорвалась.
      if (at - latest.seenAt >= FORGET_SILENT) return forget()
      if (!visible.current && at - latest.startedAt >= SHOW_AFTER) setShown(true)
    }, 250)

    return () => clearInterval(tick)
  }, [active])

  if (!job || !shown) return null

  const share = job.total > 0 ? Math.min(job.current / job.total, 1) : null
  const eta = formatEta(now - job.startedAt, job.current, job.total, t)

  return (
    <div
      className="flex h-9 min-w-0 max-w-72 flex-1 items-center gap-2.5 rounded-lg border border-line-strong bg-surface px-3"
      role="status"
      aria-live="polite"
    >
      <Spinner className="size-3.5 shrink-0 text-accent-content" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-[11.5px] leading-none">{t(job.label)}</span>
          {share !== null && (
            <span className="ml-auto shrink-0 text-[11px] leading-none tabular-nums text-content-subtle">
              {job.current} / {job.total}
            </span>
          )}
        </div>
        {/* Полоса рисуется только когда объём известен: у части работ его
            нет, и пустая шкала обещала бы то, чего мы не знаем. */}
        {share !== null && (
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-3">
            <div
              className={cx('h-full rounded-full bg-accent transition-[width] duration-300')}
              style={{ width: `${Math.round(share * 100)}%` }}
            />
          </div>
        )}
      </div>
      {eta && <span className="shrink-0 text-[11px] tabular-nums text-content-subtle">{eta}</span>}
    </div>
  )
}

/** Ход работы с сервером приходит одним событием на все её этапы. */
const API_LABEL: Record<'domains' | 'pack' | 'upload' | 'verify', MessageKey> = {
  domains: 'job.api.domains',
  pack: 'job.api.pack',
  upload: 'job.api.upload',
  verify: 'job.api.verify',
}
