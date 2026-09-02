import { useEffect, useRef, useState } from 'react'

import { CaretDown, Key } from '@phosphor-icons/react'

import { useI18n, type MessageKey } from '../i18n'
import { byEnvironment, type ConnectionProfile, type ConnectionStore, type Environment } from '../lib/connection'
import type { ServerInfo } from '../types'
import { Button, CONTROL_HEIGHT, cx, FOCUS_RING } from './ui'

/**
 * Переключатель стенда в шапке.
 *
 * Живёт на всех экранах, а не только в разделе API: сменить стенд нужно ровно
 * тогда, когда занимаешься чем-то другим.
 */

/** Состояние точки: подключено, идёт подключение или ничего нет. */
type DotKind = 'info' | 'ok' | 'warn' | 'error'

export const ENVIRONMENT_TONE: Record<Environment, string> = {
  dev: 'border-line-strong bg-surface-3 text-content-muted',
  test: 'border-accent/35 bg-accent/12 text-accent-content',
  stage: 'border-caution/35 bg-caution/12 text-caution',
  prod: 'border-negative/35 bg-negative/12 text-negative',
}

export const ENVIRONMENT_LABEL: Record<Environment, MessageKey> = {
  dev: 'env.dev',
  test: 'env.test',
  stage: 'env.stage',
  prod: 'env.prod',
}

/**
 * Открытое подключение — в строке заголовка, рядом с переключателем.
 *
 * Прежде это была полоса во всю ширину над списком стендов. Она повторяла
 * имя и среду, которые и так написаны в переключателе справа, а список
 * стендов отодвигала на строку вниз. В шапке от неё остаётся то, чего
 * в переключателе нет: версия шины, адрес с пользователем и способ
 * отключиться. Адрес подрезается — строка заголовка не должна переноситься
 * из-за длинного пути до менеджера.
 */
export function ConnectedPill({ server, onDisconnect }: {
  server: ServerInfo
  onDisconnect: () => void
}) {
  const { t } = useI18n()
  const address = `${server.baseUrl} · ${server.user}`

  return (
    <div
      // Подсказка висит на всей плашке, а не на самом адресе: в узком окне
      // адрес подрезается до нуля, и наводить было бы не на что.
      title={address}
      className={cx(
        CONTROL_HEIGHT,
        'flex min-w-0 items-center gap-2 rounded-lg border border-positive/35 bg-positive/8 pl-2.5 pr-1',
      )}
    >
      <StatusDot kind="ok" />
      {server.apiVersion && (
        <span
          title={t('header.fesbVersion')}
          className="shrink-0 rounded border border-accent/35 bg-accent/12 px-1 font-mono text-[10px] text-accent-content"
        >
          FESB {server.apiVersion}
        </span>
      )}
      <code className="min-w-0 truncate font-mono text-[11.5px] text-content-subtle">
        {address}
      </code>
      <Button size="sm" variant="ghost" className="shrink-0" onClick={onDisconnect}>
        {t('profiles.disconnect')}
      </Button>
    </div>
  )
}

/** Быстрое переключение стенда: список профилей по средам. */
export function ServerSwitch({ store, active, server, connecting, failed, onConnect, onDisconnect, onConfigure }: {
  store: ConnectionStore
  active: ConnectionProfile | null
  server: ServerInfo | null
  connecting: boolean
  /** Последнее переключение не удалось: точка красная, пока не получится. */
  failed?: boolean
  onConnect: (profile: ConnectionProfile) => void
  onDisconnect: () => void
  onConfigure: (profileId: string | null) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const holder = useRef<HTMLDivElement>(null)

  useClickAway(holder, () => setOpen(false))

  const groups = byEnvironment(store.profiles)
  const state: DotKind = connecting ? 'warn' : failed ? 'error' : server ? 'ok' : 'info'

  return (
    <div ref={holder} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title={server ? server.baseUrl : t('switch.none')}
        className={cx(
          CONTROL_HEIGHT,
          'flex max-w-64 items-center gap-2 rounded-lg border px-2.5 text-[12.5px] transition',
          FOCUS_RING,
          'border-line-strong bg-surface hover:bg-surface-2',
        )}
      >
        <StatusDot kind={state} pulse={connecting} />
        <span className="min-w-0 flex-1 truncate text-left">
          {active?.name ?? (server ? server.baseUrl : t('switch.none'))}
        </span>
        {active && (
          <span className={cx('shrink-0 rounded border px-1 text-[10px]', ENVIRONMENT_TONE[active.environment])}>
            {t(ENVIRONMENT_LABEL[active.environment])}
          </span>
        )}
        <CaretDown size={10} weight="bold" className="shrink-0 text-content-subtle" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1.5 w-72 overflow-hidden rounded-xl border border-line-strong bg-surface shadow-2xl">
          <div className="max-h-80 overflow-y-auto p-1.5">
            {groups.map(([environment, profiles]) => (
              <div key={environment} className="mb-1">
                <div className="px-2.5 py-1 text-[10px] font-semibold tracking-wide text-content-subtle">
                  {t(ENVIRONMENT_LABEL[environment])}
                </div>
                {profiles.map((profile) => {
                  const ready = profile.rememberPassword && profile.password.length > 0
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      onClick={() => {
                        setOpen(false)
                        // Без сохранённого пароля подключиться молча нельзя —
                        // ведём туда, где его спросят.
                        if (ready) onConnect(profile)
                        else onConfigure(profile.id)
                      }}
                      title={profile.url}
                      className={cx(
                        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition',
                        profile.id === active?.id ? 'bg-accent/12' : 'hover:bg-surface-3',
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate text-[12.5px]">{profile.name}</span>
                      {!ready && (
                        <Key size={12} weight="bold" className="shrink-0 text-content-subtle" aria-label={t('switch.needsPassword')} />
                      )}
                    </button>
                  )
                })}
              </div>
            ))}

            {store.profiles.length === 0 && (
              <p className="px-2.5 py-4 text-center text-[11.5px] text-content-subtle">{t('switch.empty')}</p>
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-line bg-surface-2 px-2 py-2">
            <Button size="sm" variant="ghost" onClick={() => { setOpen(false); onConfigure(null) }}>
              {t('switch.configure')}
            </Button>
            {server && (
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => { setOpen(false); onDisconnect() }}>
                {t('profiles.disconnect')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const DOT_TONE: Record<DotKind, string> = {
  info: 'bg-content-subtle/50',
  ok: 'bg-positive',
  warn: 'bg-caution',
  error: 'bg-negative',
}

function StatusDot({ kind, pulse, className }: { kind: DotKind; pulse?: boolean; className?: string }) {
  return (
    <span
      className={cx('size-2 shrink-0 rounded-full', DOT_TONE[kind], pulse && 'animate-pulse', className)}
      aria-hidden
    />
  )
}

/** Закрывает всплывающую панель по клику мимо неё и по Escape. */
function useClickAway(ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close()
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [ref, close])
}
