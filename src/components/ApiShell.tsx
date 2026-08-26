import { useCallback, useEffect, useState, type ReactNode } from 'react'

import { useI18n } from '../i18n'
import { errorText } from '../lib/api'
import type { Connection } from '../types'
import { Button, cx } from './ui'

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
        <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-surface-2 text-[22px] text-accent-content">⇄</div>
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
