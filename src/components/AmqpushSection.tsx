import { lazy, Suspense, useEffect, useState } from 'react'

import { useI18n } from '../i18n'
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
 */
const AmqpushScreen = lazy(() =>
  import('../amqpush/AmqpushScreen').then((module) => ({ default: module.AmqpushScreen })),
)

export function AmqpushSection({ active }: { active: boolean }) {
  const { t } = useI18n()
  const [opened, setOpened] = useState(active)

  useEffect(() => { if (active) setOpened(true) }, [active])

  if (!opened) return null

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <Suspense
        fallback={
          <div className="flex flex-1 items-center justify-center gap-2 text-[12.5px] text-content-muted">
            <Spinner className="size-4" />
            {t('amqp.loading')}
          </div>
        }
      >
        <AmqpushScreen />
      </Suspense>
    </div>
  )
}
