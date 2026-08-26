import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

/**
 * Журнал того, что приложение делает и что у него не получается.
 *
 * До сих пор ошибка жила на том экране, где случилась, и пропадала при
 * переключении. Массовые операции идут минутами и через несколько экранов,
 * поэтому им нужно одно общее место, куда можно вернуться и посмотреть.
 */

export type StatusKind = 'info' | 'ok' | 'warn' | 'error'

export interface StatusEvent {
  id: number
  kind: StatusKind
  text: string
  at: Date
}

/** Больше сотни записей никто не читает, а память они занимают. */
const LIMIT = 100

interface StatusValue {
  events: StatusEvent[]
  push: (kind: StatusKind, text: string) => void
  clear: () => void
  /** Сколько записей появилось с момента, когда журнал последний раз открывали. */
  unseen: number
  markSeen: () => void
  /** Последняя запись — её видно на кнопке журнала. */
  latest: StatusEvent | null
}

const StatusContext = createContext<StatusValue | null>(null)

export function StatusProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<StatusEvent[]>([])
  const [seen, setSeen] = useState(0)
  const nextId = useRef(1)

  const push = useCallback((kind: StatusKind, text: string) => {
    setEvents((prev) => {
      const event: StatusEvent = { id: nextId.current++, kind, text, at: new Date() }
      return [event, ...prev].slice(0, LIMIT)
    })
  }, [])

  const clear = useCallback(() => {
    setEvents([])
    setSeen(0)
  }, [])

  const markSeen = useCallback(() => setSeen(nextId.current - 1), [])

  const value = useMemo<StatusValue>(() => ({
    events,
    push,
    clear,
    unseen: events.filter((event) => event.id > seen).length,
    markSeen,
    latest: events[0] ?? null,
  }), [events, push, clear, seen, markSeen])

  return <StatusContext.Provider value={value}>{children}</StatusContext.Provider>
}

export function useStatus(): StatusValue {
  const value = useContext(StatusContext)
  if (!value) throw new Error('useStatus используется вне StatusProvider')
  return value
}
