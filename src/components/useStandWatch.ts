import { useEffect, useRef, useState } from 'react'

import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'

import { useI18n, type MessageKey } from '../i18n'
import { loadHealth } from '../lib/healthLoad'
import { newAlerts, WATCH_INTERVAL_MS, type Alert, type Seen } from '../lib/watch'
import type { HealthId } from '../lib/health'
import type { Connection } from '../types'
import type { ScreenId } from './Sidebar'
import { useToast } from './Toaster'

const WATCH_KEY = 'fesb.watch'

const ALERT_TEXT: Partial<Record<HealthId, MessageKey>> = {
  domains: 'watch.domains',
  certificates: 'watch.certificates',
  queues: 'watch.queues',
  modules: 'watch.modules',
}

const ALERT_SCREEN: Partial<Record<HealthId, ScreenId>> = {
  domains: 'api.domains',
  certificates: 'api.certificates',
  queues: 'api.queues',
  modules: 'api.modules',
}

/**
 * Интервал можно укоротить для проверки: `localStorage['fesb.watch.intervalMs'] = '5000'`.
 * Ждать пять минут, чтобы увидеть одно уведомление, при отладке незачем.
 */
function intervalMs(): number {
  try {
    const custom = Number(localStorage.getItem('fesb.watch.intervalMs'))
    return custom >= 1000 ? custom : WATCH_INTERVAL_MS
  } catch {
    return WATCH_INTERVAL_MS
  }
}

function readWatching(): boolean {
  try { return localStorage.getItem(WATCH_KEY) === 'on' } catch { return false }
}

/** Системное уведомление: без разрешения — молча, остаётся всплывашка в окне. */
async function notify(title: string, body: string): Promise<void> {
  try {
    let permitted = await isPermissionGranted()
    if (!permitted) permitted = (await requestPermission()) === 'granted'
    if (permitted) sendNotification({ title, body })
  } catch {
    // Уведомления недоступны — в окне сообщение всё равно покажется.
  }
}

/**
 * Фоновая проверка стенда.
 *
 * Живёт в App, а не на экране: следить надо и тогда, когда человек сидит
 * в журналах. Сообщает только о новом с прошлой проверки — правило в
 * `lib/watch`. Смена стенда начинает наблюдение заново: беды прежнего
 * к новому не относятся.
 */
export function useStandWatch(connection: Connection | null, standName: string, onScreen: (screen: ScreenId) => void) {
  const { t } = useI18n()
  const toast = useToast()
  const [watching, setWatchingState] = useState(readWatching)
  const seen = useRef<Seen | null>(null)
  // Свежие обработчики без перезапуска таймера на каждую перерисовку.
  const latest = useRef({ t, toast, onScreen, standName })
  latest.current = { t, toast, onScreen, standName }

  const setWatching = (value: boolean) => {
    setWatchingState(value)
    try { localStorage.setItem(WATCH_KEY, value ? 'on' : 'off') } catch { /* приватный режим */ }
  }

  useEffect(() => {
    seen.current = null
    if (!watching || !connection) return
    let alive = true

    const report = (alert: Alert) => {
      const { t, toast, onScreen, standName } = latest.current
      const key = ALERT_TEXT[alert.id]
      if (!key) return
      const shown = alert.items.slice(0, 3).join(', ') + (alert.items.length > 3 ? ` ${t('health.more', { count: alert.items.length - 3 })}` : '')
      const text = t(key, { items: shown })
      void notify(`FESB Toolkit · ${standName}`, text)
      const screen = ALERT_SCREEN[alert.id]
      toast({
        tone: alert.id === 'domains' || alert.id === 'modules' ? 'danger' : 'warn',
        title: standName,
        text,
        action: screen ? { label: t('watch.open'), onClick: () => onScreen(screen) } : undefined,
      })
    }

    const check = async () => {
      try {
        const checks = await loadHealth(connection)
        if (!alive) return
        const { alerts, seen: next } = newAlerts(seen.current, checks)
        seen.current = next
        alerts.forEach(report)
      } catch {
        // Стенд не ответил — попробуем в следующий раз, прежнее помним.
      }
    }

    void check()
    const timer = setInterval(() => void check(), intervalMs())
    return () => { alive = false; clearInterval(timer) }
  }, [watching, connection])

  return { watching, setWatching }
}
