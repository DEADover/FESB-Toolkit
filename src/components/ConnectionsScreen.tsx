import { useI18n } from '../i18n'
import type { ScreenId } from './Sidebar'
import { Segmented } from './ui'

/** Экраны, из которых состоит объединённое подключение. */
export const CONNECTION_SCREENS = ['connection', 'amqp.connection'] as const

export function isConnectionScreen(screen: ScreenId): boolean {
  return screen === 'connection' || screen === 'amqp.connection'
}

/**
 * Переключатель «к чему подключаемся» над формой подключения.
 *
 * Экранов подключения было два, и добирались до них двумя разными
 * шестерёнками: одна у раздела API, другая у раздела AMQP. Дело при этом
 * одно и то же — «настроить, куда ходить», — поэтому шестерёнка теперь одна,
 * в шапке приложения, а за ней два вида на одном экране.
 *
 * Формы под переключателем остались прежними: у шины и у брокера общего мало,
 * кроме самого слова «подключение», и сводить их в одну форму значило бы
 * выдумывать поля, которых нет ни у той, ни у другой стороны.
 */
export function ConnectionTabs({ screen, onScreen }: {
  screen: ScreenId
  onScreen: (screen: ScreenId) => void
}) {
  const { t } = useI18n()

  return (
    <div className="px-6 pb-3">
      <Segmented<ScreenId>
        ariaLabel={t('connections.kind')}
        value={screen === 'amqp.connection' ? 'amqp.connection' : 'connection'}
        onChange={onScreen}
        options={[
          { id: 'connection', label: t('connections.fesb') },
          { id: 'amqp.connection', label: t('connections.amqp') },
        ]}
      />
    </div>
  )
}
