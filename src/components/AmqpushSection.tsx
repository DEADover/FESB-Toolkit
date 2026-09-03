import { lazy, Suspense, useEffect, useState } from 'react'

import { useI18n } from '../i18n'
import { brokerProfile, hasBroker } from '../lib/broker'
import type { ConnectionProfile } from '../lib/connection'
import type { Profile, View } from '../amqpush/types'
import type { ScreenId } from './Sidebar'
import { Spinner } from './ui'

/**
 * Раздел AMQP — перенесённое приложение AMQPush целиком.
 *
 * Грузится отдельным куском и только при первом открытии: раздел тянет за
 * собой редактор кода, разбор CSV, проверку XML и генератор тестовых
 * значений — всё это ни к чему тому, кто пришёл править трассировку.
 *
 * После открытия остаётся в дереве и прячется скрытием, а не размонтированием.
 * Подписчик на очередь живёт в Rust и переживает уход на соседний экран,
 * а вот принятые сообщения, набранное тело и настройки отправки живут
 * в состоянии React — и пропали бы вместе с ним.
 *
 * Экран выбирается снаружи, боковой панелью приложения: у раздела своих
 * вкладок больше нет, его семь экранов стоят наравне с остальными.
 */
const AmqpushScreen = lazy(() =>
  import('../amqpush/AmqpushScreen').then((module) => ({ default: module.AmqpushScreen })),
)

/** Экран приложения ↔ экран раздела. Имена внутри раздела свои, исторические. */
const VIEWS: Partial<Record<ScreenId, View>> = {
  'amqp.publisher': 'publisher',
  'amqp.subscriber': 'subscriber',
  'amqp.browser': 'browser',
  'amqp.inspector': 'inspector',
  'amqp.history': 'history',
  'amqp.stats': 'stats',
  'amqp.console': 'console',
}

const SCREENS: Record<View, ScreenId> = {
  publisher: 'amqp.publisher',
  subscriber: 'amqp.subscriber',
  browser: 'amqp.browser',
  inspector: 'amqp.inspector',
  history: 'amqp.history',
  stats: 'amqp.stats',
  console: 'amqp.console',
}

export function AmqpushSection({ screen, onScreen, profiles, activeProfileId }: {
  screen: ScreenId
  onScreen: (screen: ScreenId) => void
  /** Стенды приложения: брокер — часть профиля стенда, а не своя сущность. */
  profiles: ConnectionProfile[]
  activeProfileId: string | null
}) {
  const { t } = useI18n()
  const view = VIEWS[screen]
  const [opened, setOpened] = useState(view !== undefined)

  useEffect(() => { if (view) setOpened(true) }, [view])

  // Брокер выбранного стенда — и брокеры остальных, чтобы было куда
  // переливать сообщения.
  const active = profiles.find((profile) => profile.id === activeProfileId) ?? null
  const stand: Profile | null = active ? brokerProfile(active) : null
  const stands: Profile[] = profiles.filter(hasBroker).map(brokerProfile)

  if (!opened) return null

  return (
    <div className={view ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <Suspense
        fallback={
          <div className="flex flex-1 items-center justify-center gap-2 text-[12.5px] text-content-muted">
            <Spinner className="size-4" />
            {t('amqp.loading')}
          </div>
        }
      >
        {/*
          Пока раздел спрятан, `view` пуст — показываем последний открытый
          экран, чтобы его состояние не сбрасывалось. Смена экрана изнутри
          (горячие клавиши раздела, ссылки «отправить сюда») поднимается
          наверх и подсвечивает нужный пункт панели.
        */}
        <AmqpushScreen
          view={view ?? 'publisher'}
          visible={view !== undefined}
          onView={(next) => onScreen(SCREENS[next])}
          stand={stand}
          stands={stands}
          onConfigure={() => onScreen('connection')}
        />
      </Suspense>
    </div>
  )
}
