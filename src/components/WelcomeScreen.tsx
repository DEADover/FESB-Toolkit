import { ArrowsLeftRight, Crosshair, FlowArrow, FolderOpen, Plugs, Stack, type Icon } from '@phosphor-icons/react'

import { useI18n } from '../i18n'
import type { ConnectionProfile, ConnectionStore } from '../lib/connection'
import { byEnvironment } from '../lib/connection'
import type { ServerInfo } from '../types'
import { ENVIRONMENT_LABEL, ENVIRONMENT_TONE } from './HeaderBar'
import type { ScreenId } from './Sidebar'
import { Badge, Button, cx, FOCUS_RING } from './ui'

interface Props {
  server: ServerInfo | null
  connections: ConnectionStore
  connecting: boolean
  onScreen: (screen: ScreenId) => void
  onOpenFolder: () => void
  onOpenArchive: () => void
  onConnect: (profile: ConnectionProfile) => void
}

/**
 * Первый экран.
 *
 * Раньше приложение открывалось сразу в настройках трассировки — с пустой
 * таблицей и просьбой выбрать папку. Начинать с одного из двух способов
 * работы честнее: с файлами на диске или с живым сервером. Отсюда же видно,
 * какие стенды заведены, и к любому можно подключиться в одно нажатие.
 */
export function WelcomeScreen({
  server, connections, connecting, onScreen, onOpenFolder, onOpenArchive, onConnect,
}: Props) {
  const { t } = useI18n()
  const groups = byEnvironment(connections.profiles)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 pt-4">
        {/* Название приложения уже стоит в шапке страницы — здесь только суть. */}
        <p className="max-w-2xl text-[12.5px] leading-relaxed text-content-subtle">{t('welcome.text')}</p>

        <div className="grid gap-3 md:grid-cols-2">
          {/* Два способа работы, и оба начинаются здесь. */}
          <Card
            icon={FolderOpen}
            title={t('welcome.files')}
            text={t('welcome.files.text')}
            action={
              <>
                <Button variant="primary" onClick={onOpenFolder}>{t('action.selectFolder')}</Button>
                <Button onClick={onOpenArchive}>{t('action.openArchive')}</Button>
              </>
            }
          />
          <Card
            icon={Plugs}
            title={t('welcome.server')}
            text={t('welcome.server.text')}
            action={
              server
                ? <Button variant="primary" onClick={() => onScreen('api.domains')}>{t('nav.api.domains.title')}</Button>
                : <Button variant="primary" onClick={() => onScreen('api.connection')}>{t('nav.api.connection')}</Button>
            }
          />
        </div>

        {connections.profiles.length > 0 && !server && (
          <section>
            <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-content-subtle">
              {t('welcome.stands')}
            </h3>
            <div className="flex flex-col gap-1.5">
              {groups.map(([environment, profiles]) => profiles.map((profile) => {
                // Без сохранённого пароля подключиться молча нельзя —
                // такой профиль ведёт на экран подключения, а не в тупик.
                const ready = profile.rememberPassword && profile.password.length > 0
                return (
                  <button
                    key={profile.id}
                    type="button"
                    disabled={connecting}
                    onClick={() => (ready ? onConnect(profile) : onScreen('api.connection'))}
                    className={cx(
                      'flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2.5 text-left transition',
                      'hover:border-line-strong hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50',
                      FOCUS_RING,
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium">{profile.name}</span>
                      <span className="block truncate font-mono text-[10.5px] text-content-subtle">{profile.url}</span>
                    </span>
                    <Badge className={ENVIRONMENT_TONE[environment]}>{t(ENVIRONMENT_LABEL[environment])}</Badge>
                    <span className="shrink-0 text-[11.5px] text-content-subtle">
                      {ready ? t('welcome.connect') : t('switch.needsPassword')}
                    </span>
                  </button>
                )
              }))}
            </div>
          </section>
        )}

        <section>
          <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-content-subtle">
            {t('welcome.whatFor')}
          </h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Hint icon={Crosshair} title={t('nav.files.trace')} text={t('welcome.hint.trace')} onClick={() => onScreen('files.trace')} />
            <Hint icon={Stack} title={t('nav.api.domains.title')} text={t('welcome.hint.domains')} onClick={() => onScreen('api.domains')} />
            <Hint icon={FlowArrow} title={t('nav.api.routes.title')} text={t('welcome.hint.routes')} onClick={() => onScreen('api.routes')} />
            <Hint icon={ArrowsLeftRight} title={t('nav.api.endpoints.title')} text={t('welcome.hint.endpoints')} onClick={() => onScreen('api.endpoints')} />
          </div>
        </section>
      </div>
    </div>
  )
}

function Card({ icon: Glyph, title, text, action }: {
  icon: Icon
  title: string
  text: string
  action: React.ReactNode
}) {
  return (
    <div className="flex flex-col rounded-2xl border border-line bg-surface p-5">
      <span className="grid size-10 place-items-center rounded-xl bg-surface-2 text-accent-content">
        <Glyph size={20} weight="regular" />
      </span>
      <h3 className="mt-3 text-[14px] font-semibold">{title}</h3>
      <p className="mt-1.5 flex-1 text-[12px] leading-relaxed text-content-subtle">{text}</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">{action}</div>
    </div>
  )
}

/** Короткая карточка «что здесь делают»: заголовок, строка пояснения и переход. */
function Hint({ icon: Glyph, title, text, onClick }: {
  icon: Icon
  title: string
  text: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'flex flex-col rounded-xl border border-line bg-surface px-3.5 py-3 text-left transition',
        'hover:border-line-strong hover:bg-surface-2',
        FOCUS_RING,
      )}
    >
      <span className="flex items-center gap-2">
        <Glyph size={15} weight="regular" className="shrink-0 text-content-subtle" />
        <span className="min-w-0 truncate text-[12px] font-medium">{title}</span>
      </span>
      <span className="mt-1 text-[11px] leading-relaxed text-content-subtle">{text}</span>
    </button>
  )
}
