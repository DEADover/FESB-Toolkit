import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { ArrowsLeftRight } from '@phosphor-icons/react'

import { useI18n } from '../i18n'
import { errorText } from '../lib/api'
import type { Connection } from '../types'
import { Button, Checkbox, cx } from './ui'

/**
 * Общая обвязка для экранов раздела API: все они читают что-то с сервера,
 * умеют обновляться и одинаково ведут себя без подключения.
 */

/** Заглушка для экрана, открытого до подключения к серверу. */
export function NotConnected({ onGoToConnection }: { onGoToConnection: () => void }) {
  const { t } = useI18n()
  return (
    <div className="flex flex-1 items-center justify-center px-6 pb-10">
      <div className="max-w-md text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-surface-2 text-accent-content">
          <ArrowsLeftRight size={24} weight="regular" />
        </div>
        <h2 className="mt-4 text-[15px] font-semibold">{t('api.notConnected')}</h2>
        <p className="mt-2 text-content-subtle">{t('api.notConnected.text')}</p>
        <Button variant="primary" className="mt-5" onClick={onGoToConnection}>{t('nav.api.connection')}</Button>
      </div>
    </div>
  )
}

export function ErrorBar({ error }: { error: string | null }) {
  if (!error) return null
  return <div className="rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-negative">{error}</div>
}

/** Пустая таблица и «идёт загрузка» выглядят одинаково на всех экранах. */
export function TableMessage({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-10 text-center text-content-subtle">{children}</td>
    </tr>
  )
}

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('min-h-0 overflow-auto rounded-xl border border-line bg-surface', className)}>{children}</div>
}

interface Resource<T> {
  data: T | null
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  setError: (error: string | null) => void
}

/**
 * Читает данные с сервера и перечитывает их при смене подключения.
 *
 * `load` обязан быть стабильным (useCallback) — иначе чтение зациклится.
 */
export function useApiData<T>(
  connection: Connection | null,
  load: (connection: Connection) => Promise<T>,
): Resource<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!connection) {
      setData(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      setData(await load(connection))
    } catch (err) {
      setError(errorText(err))
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [connection, load])

  useEffect(() => { void reload() }, [reload])

  return { data, loading, error, reload, setError }
}

/** Период автообновления: чаще смысла нет, счётчики шина считает не мгновенно. */
const REFRESH_MS = 10_000

/**
 * Повторяет чтение, пока включено. Действие берётся через ref, поэтому таймер
 * не перезапускается от каждой смены фильтров — иначе он бы никогда не срабатывал.
 */
export function useAutoRefresh(enabled: boolean, action: () => unknown) {
  const latest = useRef(action)
  latest.current = action

  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => { void latest.current() }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [enabled])
}

/**
 * Чип-фильтр со счётчиком: журналы и аудит устроены одинаково, и выглядеть
 * должны так же. Свой цвет активного состояния нужен только уровням журнала,
 * где красное и жёлтое несут смысл.
 */
export function FilterChip({ active, count, activeClass, className, title, onClick, children }: {
  active: boolean
  count?: ReactNode
  activeClass?: string
  className?: string
  title?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cx(
        'flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-[11.5px] transition',
        active
          ? activeClass ?? 'border-accent/50 bg-accent/12 text-accent-content'
          : 'border-line-strong text-content-muted hover:bg-surface-3',
        className,
      )}
    >
      {children}
      {count !== undefined && count !== null && (
        <span className="rounded bg-surface-3 px-1 text-[10px] tabular-nums">{count}</span>
      )}
    </button>
  )
}

/** Переключатель автообновления — один и тот же на всех живых экранах. */
export function AutoRefreshToggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  const { t } = useI18n()
  return (
    <label
      title={t('logs.autoHint')}
      className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 text-[12.5px] text-content-muted"
    >
      <Checkbox checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {t('logs.auto')}
    </label>
  )
}
