import { useCallback, useMemo } from 'react'

import { ArrowRight, FolderOpen, Plugs, type Icon } from '@phosphor-icons/react'

import { useI18n } from '../i18n'
import { apiServerUsage } from '../lib/api'
import { formatUptime } from '../lib/format'
import { useApiData } from './ApiShell'
import { byEnvironment, type ConnectionProfile, type ConnectionStore } from '../lib/connection'
import type { Connection, ScanResult, ServerInfo, ServerUsage } from '../types'
import { ENVIRONMENT_LABEL, ENVIRONMENT_TONE } from './HeaderBar'
import { API_SCREENS, FILE_SCREENS, sortByLabel, type ScreenEntry, type ScreenId } from './Sidebar'
import { Badge, Button, cx, FOCUS_RING, Readout } from './ui'

interface Props {
  server: ServerInfo | null
  /** Открытое подключение — по нему карточка спрашивает состояние сервера. */
  connection: Connection | null
  scan: ScanResult | null
  sourcePath: string | null
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
 * таблицей и просьбой выбрать папку. Начинать с состояния честнее: что уже
 * открыто, к чему подключены и куда отсюда можно пойти. Пока ничего не
 * открыто, экран показывает два способа начать; как только появляется
 * выгрузка или сервер, на их месте оказываются цифры и продолжение работы.
 */
export function WelcomeScreen({
  server, connection, scan, sourcePath, connections, connecting,
  onScreen, onOpenFolder, onOpenArchive, onConnect,
}: Props) {
  const { t, language } = useI18n()

  const files = useMemo(() => {
    if (!scan) return null
    let traces = 0
    let routes = 0
    for (const domain of scan.domains) {
      traces += domain.traces.length
      routes += domain.routes.length
    }
    return { domains: scan.domains.length, traces, routes }
  }, [scan])

  const runningModules = server ? server.modules.filter((module) => module.running).length : 0
  const groups = byEnvironment(connections.profiles)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        {/*
          Первое, что видно, — состояние, а не приветствие. Если работа уже
          начата, тут её цифры; если нет, тут два способа её начать.
        */}
        <section className="grid gap-4 lg:grid-cols-2">
          <Panel
            icon={FolderOpen}
            title={t('welcome.files')}
            open={files !== null}
            caption={sourcePath}
          >
            {files ? (
              <>
                <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
                  <Readout label={t('stats.domains')} value={files.domains.toLocaleString()} />
                  <Readout label={t('stats.traceBeans')} value={files.traces.toLocaleString()} />
                  <Readout label={t('stats.routes')} value={files.routes.toLocaleString()} />
                  {scan?.fesbVersion && (
                    <Readout label="FESB" value={scan.fesbVersion} hint={t('header.fesbVersion')} />
                  )}
                </div>
                <Actions>
                  <Button variant="primary" onClick={() => onScreen('files.trace')}>
                    {t('welcome.continue')} <ArrowRight size={13} weight="bold" />
                  </Button>
                  <Button onClick={() => onScreen('files.links')}>{t('nav.files.links')}</Button>
                  <Button variant="ghost" onClick={onOpenFolder}>{t('welcome.another')}</Button>
                </Actions>
              </>
            ) : (
              <>
                <p className="text-[12px] leading-relaxed text-content-subtle">{t('welcome.files.text')}</p>
                <Actions>
                  <Button variant="primary" onClick={onOpenFolder}>{t('action.selectFolder')}</Button>
                  <Button onClick={onOpenArchive}>{t('action.openArchive')}</Button>
                </Actions>
              </>
            )}
          </Panel>

          <Panel
            icon={Plugs}
            title={t('welcome.server')}
            open={server !== null}
            caption={server?.baseUrl ?? null}
          >
            {server ? (
              <>
                <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
                  <Readout
                    label={t('map.domains')}
                    value={`${server.activeDomains} / ${server.domains}`}
                    hint={t('map.domains.hint')}
                  />
                  <Readout label={t('nav.api.modules')} value={`${runningModules} / ${server.modules.length}`} />
                  <Readout label={t('api.info.user')} value={server.user} />
                  {server.apiVersion && <Readout label="FESB" value={server.apiVersion} />}
                  <Uptime connection={connection} />
                </div>
                <Actions>
                  <Button variant="primary" onClick={() => onScreen('api.domains')}>
                    {t('nav.api.domains.title')} <ArrowRight size={13} weight="bold" />
                  </Button>
                  <Button onClick={() => onScreen('api.endpoints')}>{t('nav.api.endpoints')}</Button>
                  <Button variant="ghost" onClick={() => onScreen('api.connection')}>{t('nav.api.connection')}</Button>
                </Actions>
              </>
            ) : (
              <>
                <p className="text-[12px] leading-relaxed text-content-subtle">{t('welcome.server.text')}</p>
                <Actions>
                  <Button variant="primary" onClick={() => onScreen('api.connection')}>
                    {t('welcome.connect')}
                  </Button>
                </Actions>
              </>
            )}
          </Panel>
        </section>

        {connections.profiles.length > 0 && !server && (
          <Section title={t('welcome.stands')}>
            <div className="grid gap-2 md:grid-cols-2">
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
                      'group flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left transition',
                      'hover:border-accent/40 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50',
                      FOCUS_RING,
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 truncate text-[12.5px] font-medium">{profile.name}</span>
                        <Badge className={ENVIRONMENT_TONE[environment]}>{t(ENVIRONMENT_LABEL[environment])}</Badge>
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[10.5px] text-content-subtle">
                        {profile.url}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-[11px] text-content-subtle">
                        {ready ? t('welcome.connect') : t('switch.needsPassword')}
                      </span>
                      {profile.lastUsedAt && (
                        <span className="block text-[10.5px] text-content-subtle/70">
                          {t('welcome.lastUsed', { when: shortDate(profile.lastUsedAt) })}
                        </span>
                      )}
                    </span>
                    <ArrowRight
                      size={13}
                      weight="bold"
                      className="shrink-0 text-content-subtle transition group-hover:text-accent-content"
                    />
                  </button>
                )
              }))}
            </div>
          </Section>
        )}

        {/*
          Плитки разложены теми же двумя разделами, что и боковая панель:
          десять одинаковых карточек подряд читаются как стена, а так видно,
          что половина из них про файлы, а половина — про живой сервер.
        */}
        <Section title={t('nav.files')}>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {FILE_SCREENS.map((entry) => (
              <Tile key={entry.id} entry={entry} onClick={() => onScreen(entry.id)} />
            ))}
          </div>
        </Section>

        {/* Разделы по алфавиту — так же, как в боковой панели. Алфавит
            зависит от языка, поэтому порядок считается при отрисовке. */}
        <Section title={t('nav.api')} note={server ? undefined : t('welcome.needsServer')}>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {sortByLabel(API_SCREENS, (entry) => t(entry.title ?? entry.label), language).map((entry) => (
              <Tile key={entry.id} entry={entry} dim={!server} onClick={() => onScreen(entry.id)} />
            ))}
          </div>
        </Section>
      </div>
    </div>
  )
}

/** Одна из двух главных карточек: значок, название, подпись и содержимое. */
function Panel({ icon: Glyph, title, caption, open, children }: {
  icon: Icon
  title: string
  caption: string | null
  /** Работа уже начата: карточку стоит выделить, а не оставлять серой. */
  open: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={cx(
        'flex flex-col gap-4 rounded-2xl border p-5 transition',
        open ? 'border-accent/30 bg-surface' : 'border-line bg-surface',
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cx(
            'grid size-9 shrink-0 place-items-center rounded-xl',
            open ? 'bg-accent/15 text-accent-content' : 'bg-surface-2 text-content-subtle',
          )}
        >
          <Glyph size={18} weight="regular" />
        </span>
        <span className="min-w-0 flex-1 pt-0.5">
          <span className="block text-[13.5px] font-semibold">{title}</span>
          {caption && (
            <span className="mt-0.5 block truncate font-mono text-[10.5px] text-content-subtle" title={caption}>
              {caption}
            </span>
          )}
        </span>
      </div>
      {children}
    </div>
  )
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">{children}</div>
}

function Section({ title, note, children }: {
  title: string
  /** Приписка справа от заголовка: например, что раздел ждёт подключения. */
  note?: string
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="mb-2.5 flex items-baseline gap-2">
        <h3 className="text-[11px] font-semibold tracking-wide text-content-subtle">{title}</h3>
        {note && <span className="text-[10.5px] text-content-subtle/70">{note}</span>}
      </div>
      {children}
    </section>
  )
}

/** Плитка раздела: куда пойти и зачем. */
function Tile({ entry, onClick, dim }: {
  entry: ScreenEntry
  onClick: () => void
  /** Раздел ждёт подключения: приглушаем, но не запрещаем — зайти можно. */
  dim?: boolean
}) {
  const { t } = useI18n()
  const Glyph = entry.icon
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'group flex flex-col rounded-xl border border-line bg-surface px-4 py-3.5 text-left transition',
        'hover:border-accent/40 hover:bg-surface-2',
        dim && 'opacity-60 hover:opacity-100',
        FOCUS_RING,
      )}
    >
      <span className="grid size-7 place-items-center rounded-lg bg-surface-2 text-content-subtle transition group-hover:bg-accent/15 group-hover:text-accent-content">
        <Glyph size={15} weight="regular" />
      </span>
      <span className="mt-2.5 truncate text-[12.5px] font-medium">{t(entry.title ?? entry.label)}</span>
      <span className="mt-1 text-[11px] leading-relaxed text-content-subtle">{t(entry.hint)}</span>
    </button>
  )
}

/** `2026-08-27T13:22:31` → `27.08 13:22`. */
function shortDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2})/.exec(value)
  return match ? `${match[3]}.${match[2]} ${match[4]}` : value
}

/**
 * Сколько шина работает — показатель, который есть только здесь.
 *
 * Отдельным запросом и молча: это приятная подробность, а не то, ради
 * чего открывают экран, и падать из-за неё карточка не должна.
 */
function Uptime({ connection }: { connection: Connection | null }) {
  const { t } = useI18n()
  const load = useCallback((open: Connection) => apiServerUsage(open), [])
  const { data } = useApiData<ServerUsage>(connection, load)
  if (!data?.uptime) return null
  return <Readout label={t('server.uptime')} value={formatUptime(data.uptime, t)} />
}
