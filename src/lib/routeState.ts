import type { MessageKey, Translate } from '../i18n'

/** Состояния СОПС так, как их называет шина. */
const LABELS: Record<string, MessageKey> = {
  Started: 'routeState.started',
  Stopped: 'routeState.stopped',
  Suspended: 'routeState.suspended',
}

/**
 * Состояние СОПС словами интерфейса.
 *
 * Шина отдаёт `Started` и `Stopped`, и в русском интерфейсе они стояли
 * английскими словами посреди русской таблицы. Незнакомое состояние
 * показывается как есть: выдумывать перевод хуже, чем оставить слово шины.
 */
export function routeStateLabel(state: string | null | undefined, t: Translate): string {
  if (!state) return '—'
  const key = LABELS[state]
  return key ? t(key) : state
}
