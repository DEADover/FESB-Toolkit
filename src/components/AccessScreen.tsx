import { Fragment, useCallback, useMemo, useState } from 'react'

import { ShieldWarning } from '@phosphor-icons/react'

import { useI18n, type MessageKey } from '../i18n'
import { apiAccess } from '../lib/api'
import type { AccessReport, Connection, Scope, ServerInfo } from '../types'
import {
  ErrorBar, NotConnected, Panel, RefreshButton, ScreenBody, ScreenBodyRow, StatsBar, useApiData,
  useDebounced,
} from './ApiShell'
import { Badge, Button, cx, EmptyState, Readout, SearchInput } from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  onGoToConnection: () => void
}

/**
 * Роли и доступ.
 *
 * Аудит отвечает, кто что **сделал**; этот экран — кто что **может**.
 * Вопрос возникает ровно тогда, когда в аудите нашлось лишнее или,
 * наоборот, у кого-то не сработала выгрузка.
 *
 * Права показаны не списком кодов, а по разделам и человеческими словами:
 * `DOMAIN_ACTION_ALL` ничего не говорит, «Домены брокера · Управление всеми
 * доменами» говорит всё. Описания приходят от шины и уже по-русски —
 * переводить их нечем, да и незачем.
 */
export function AccessScreen({ connection, server, onGoToConnection }: Props) {
  const { t } = useI18n()
  const load = useCallback((open: Connection) => apiAccess(open), [])
  const { data, loading, error, reload } = useApiData<AccessReport>(connection, load)

  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const query = useDebounced(search, 250)

  const roles = useMemo(() => data?.roles ?? [], [data])
  const role = useMemo(
    () => roles.find((item) => item.name === selected) ?? roles[0] ?? null,
    [roles, selected],
  )

  /** Что означает каждое право: по коду — раздел и описание. */
  const catalogue = useMemo(() => {
    const map = new Map<string, { group: string; description: string }>()
    for (const item of data?.permissions ?? []) map.set(item.name, item)
    return map
  }, [data])

  /**
   * Права выбранной роли, разложенные по разделам шины.
   *
   * Сто девять прав подряд — это стена; те же сто девять по тридцати
   * разделам читаются за один взгляд.
   */
  const groups = useMemo(() => {
    if (!role) return []
    const needle = query.trim().toLowerCase()
    const buckets = new Map<string, Array<{ name: string; description: string }>>()
    for (const name of role.permissions) {
      const known = catalogue.get(name)
      const group = known?.group || '—'
      const description = known?.description || name
      if (needle && !description.toLowerCase().includes(needle) && !name.toLowerCase().includes(needle)) {
        continue
      }
      const list = buckets.get(group)
      if (list) list.push({ name, description })
      else buckets.set(group, [{ name, description }])
    }
    return [...buckets.entries()]
      .map(([group, items]) => ({ group, items }))
      .sort((a, b) => b.items.length - a.items.length || a.group.localeCompare(b.group))
  }, [role, catalogue, query])

  const shown = groups.reduce((sum, group) => sum + group.items.length, 0)

  const totals = useMemo(() => ({
    roles: roles.length,
    permissions: data?.permissions.length ?? 0,
    online: (data?.users ?? []).filter((user) => user.sessions.length > 0).length,
    sessions: (data?.users ?? []).reduce(
      (sum, user) => sum + user.sessions.reduce((inner, session) => inner + session.count, 0),
      0,
    ),
  }), [data, roles])

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  if (data !== null && roles.length === 0) {
    return (
      <ScreenBody>
        <ErrorBar error={error} />
        <EmptyState icon={ShieldWarning} title={t('access.empty')} text={t('access.empty.text')}>
          <div className="mt-4">
            <Button onClick={onGoToConnection}>{t('nav.api.connection')}</Button>
          </div>
        </EmptyState>
      </ScreenBody>
    )
  }

  return (
    <ScreenBody>
      <StatsBar>
        <Readout label={t('access.roles')} value={totals.roles.toLocaleString()} />
        <Readout label={t('access.permissions')} value={totals.permissions.toLocaleString()} />
        <Readout
          label={t('access.online')}
          value={totals.online.toLocaleString()}
          tone="accent"
          hint={t('access.online.hint')}
        />
        <Readout label={t('access.sessions')} value={totals.sessions.toLocaleString()} />
        <div className="ml-auto">
          <RefreshButton className="min-w-32" busy={loading} onClick={() => void reload()} />
        </div>
      </StatsBar>

      <ErrorBar error={error} />

      <ScreenBodyRow>
        <Panel className="w-60 shrink-0 xl:w-72">
          <div className="sticky top-0 z-10 border-b border-line bg-surface-2 px-3 py-2">
            <span className="text-[11px] tracking-wide text-content-subtle">{t('access.role')}</span>
          </div>
          <div className="flex flex-col p-1.5">
            {roles.map((item) => (
              <button
                key={item.name}
                type="button"
                onClick={() => setSelected(item.name)}
                className={cx(
                  'flex items-center gap-2 rounded-lg px-2.5 py-2 text-left transition',
                  role?.name === item.name ? 'bg-accent/12' : 'hover:bg-surface-3',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12px]">{item.name}</span>
                  <span className="block truncate text-[10.5px] text-content-subtle">
                    {t('access.permissions')}: {item.permissions.length}
                  </span>
                </span>
              </button>
            ))}
          </div>

          <SignInCard report={data} />

          <Users report={data} />
        </Panel>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput
              className="min-w-64 flex-1"
              value={search}
              placeholder={t('access.search')}
              onChange={setSearch}
              clearLabel={t('action.clearSearch')}
            />
            <span className="text-[11.5px] tabular-nums text-content-subtle">
              {t('map.shown', { visible: shown, total: role?.permissions.length ?? 0 })}
            </span>
          </div>

          <Panel className="flex-1">
            {role ? (
              <div className="p-4">
                {role.scopes.length > 0 && (
                  <div className="mb-4 rounded-lg border border-line bg-surface-2/60 p-3">
                    <div className="mb-2 text-[11px] tracking-wide text-content-subtle" title={t('access.scopes.hint')}>
                      {t('access.scopes')}
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {role.scopes.map((scope) => <ScopeLine key={`${scope.subject}-${scope.action}`} scope={scope} />)}
                    </div>
                  </div>
                )}

                {groups.map((group) => (
                  <Fragment key={group.group}>
                    <div className="mb-1.5 mt-3 flex items-center gap-2 first:mt-0">
                      <span className="text-[11.5px] font-semibold">{group.group}</span>
                      <Badge>{group.items.length}</Badge>
                    </div>
                    <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2 xl:grid-cols-3">
                      {group.items.map((item) => (
                        <div key={item.name} className="min-w-0 truncate text-[12px]" title={item.name}>
                          {item.description}
                        </div>
                      ))}
                    </div>
                  </Fragment>
                ))}

                {groups.length === 0 && (
                  <p className="py-10 text-center text-content-subtle">{t('access.nothing')}</p>
                )}
              </div>
            ) : (
              <p className="py-10 text-center text-content-subtle">
                {loading ? t('empty.scanning') : t('access.pickRole')}
              </p>
            )}
          </Panel>
        </div>
      </ScreenBodyRow>
    </ScreenBody>
  )
}

/** Ограничение роли одной строкой: «Файлы журналов · просмотр → core, broker». */
function ScopeLine({ scope }: { scope: Scope }) {
  const { t } = useI18n()
  const subject = `scope.${scope.subject}` as MessageKey
  const action = `scope.${scope.action}` as MessageKey
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-[11.5px]">
      <span className="shrink-0 text-content-muted">
        {t(subject)} · {t(action)}
      </span>
      <span className="min-w-0 truncate font-mono text-[11px] text-content-subtle" title={scope.values.join(', ')}>
        {scope.values.join(', ')}
      </span>
    </div>
  )
}

/** Кто сейчас в системе — под списком ролей: это вторая половина того же вопроса. */
function Users({ report }: { report: AccessReport | null }) {
  const { t } = useI18n()
  const users = report?.users ?? []
  return (
    <div className="border-t border-line px-3 py-2.5">
      <div className="mb-2 text-[11px] tracking-wide text-content-subtle">{t('access.users')}</div>
      {users.length === 0 && <p className="text-[11.5px] text-content-subtle">{t('access.noUsers')}</p>}
      {users.map((user) => (
        <div key={user.user} className="mb-2.5 last:mb-0">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 truncate text-[12px] font-medium">{user.user}</span>
            {user.lastLogin !== null && (
              <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-content-subtle" title={t('access.lastLogin')}>
                {new Date(user.lastLogin).toLocaleString()}
              </span>
            )}
          </div>
          {user.sessions.map((session) => (
            <div
              key={`${session.ip}-${session.agent ?? ''}`}
              className="truncate text-[10.5px] text-content-subtle"
              title={session.agent ?? undefined}
            >
              <span className="font-mono">{session.ip || '—'}</span>
              {session.count > 1 && ` · ${t('access.sameAddress', { count: session.count })}`}
              {session.agent && ` · ${shortAgent(session.agent)}`}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * Имя клиента коротко.
 *
 * Строка браузера — это полторы сотни знаков про движки, из которых
 * полезны два слова: чем именно ходили.
 */
function shortAgent(agent: string): string {
  const browser = /(Chrome|Firefox|Safari|Edg)\/[\d.]+/.exec(agent)
  if (browser) return browser[0].replace('Edg/', 'Edge/')
  return agent.length > 24 ? `${agent.slice(0, 24)}…` : agent
}

/**
 * Как устроен вход.
 *
 * Роли отвечают, что человеку можно; это — как он вообще попадает внутрь.
 * Две вещи здесь отмечаются, а не просто показываются: устаревший хеш
 * пароля и политика, под которую подходит любой пароль. И то и другое
 * ищут в первую очередь, когда приходят проверять стенд.
 */
function SignInCard({ report }: { report: AccessReport | null }) {
  const { t } = useI18n()
  if (!report) return null
  const { signIn } = report

  const sources = [signIn.ldap && 'LDAP', signIn.oauth && 'OAuth'].filter(Boolean) as string[]
  return (
    <div className="border-t border-line px-3 py-2.5">
      <div className="mb-2 text-[11px] tracking-wide text-content-subtle">{t('access.signIn')}</div>
      <dl className="flex flex-col gap-1.5 text-[11.5px]">
        <Fact label={t('access.source')} value={sources.join(', ') || t('access.source.local')} />
        {signIn.maxAttempts !== null && (
          <Fact label={t('access.attempts')} value={String(signIn.maxAttempts)} />
        )}
        <Fact
          label={t('access.policy')}
          value={signIn.anyPassword ? t('access.policy.any') : signIn.passwordPolicy ?? '—'}
          mono={!signIn.anyPassword}
          warn={signIn.anyPassword}
        />
        {signIn.passwordEncoder && (
          <Fact
            label={t('access.encoder')}
            value={signIn.passwordEncoder}
            warn={signIn.weakEncoder}
            hint={signIn.weakEncoder ? t('access.encoder.weak') : undefined}
          />
        )}
        {signIn.blockInactive !== null && (
          <Fact
            label={t('access.blockInactive')}
            value={signIn.blockInactive ? t('action.on') : t('action.off')}
          />
        )}
      </dl>
    </div>
  )
}

/** Строка «подпись — значение»; отмеченное значение выделено цветом. */
function Fact({ label, value, mono, warn, hint }: {
  label: string
  value: string
  mono?: boolean
  warn?: boolean
  hint?: string
}) {
  return (
    <div className="flex items-baseline gap-2" title={hint}>
      <dt className="shrink-0 text-content-subtle">{label}</dt>
      <dd
        className={cx(
          'ml-auto min-w-0 truncate text-right',
          mono && 'font-mono text-[11px]',
          warn ? 'text-caution' : 'text-content',
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  )
}
