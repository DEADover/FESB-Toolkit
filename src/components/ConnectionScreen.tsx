import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'

import { ArrowsLeftRight, Check } from '@phosphor-icons/react'

import { useI18n, type MessageKey } from '../i18n'
import { apiConnect, apiServerUsage, errorText } from '../lib/api'
import { formatBytes, formatShare, formatUptime } from '../lib/format'
import {
  blankProfile, byEnvironment, isReady, markUsed, removeProfile, toConnection, upsertProfile,
  writeStore, type ConnectionProfile, type ConnectionStore, type Environment,
} from '../lib/connection'
import type { Connection, DiskUsage, ServerInfo, ServerUsage } from '../types'
import { ScreenBody, ScreenBodyRow, useApiData } from './ApiShell'
import { Badge, Button, Checkbox, cx, Modal, Notice, Segmented, Spinner, TextInput, TextReadout, Toggle } from './ui'

interface Props {
  store: ConnectionStore
  onStore: (store: ConnectionStore) => void
  server: ServerInfo | null
  /** Открытое подключение — по нему карточка спрашивает состояние сервера. */
  connection: Connection | null
  /** Идентификатор профиля, которым открыто текущее подключение. */
  activeProfileId: string | null
  /** Профиль, который надо раскрыть при переходе из шапки. */
  focusProfileId?: string | null
  onConnect: (profile: ConnectionProfile) => Promise<void>
  onDisconnect: () => void
}

/** Цвет среды: боевой стенд должен быть виден с одного взгляда. */
const ENVIRONMENT_TONE: Record<Environment, 'neutral' | 'accent' | 'warn' | 'danger'> = {
  dev: 'neutral',
  test: 'accent',
  stage: 'warn',
  prod: 'danger',
}

const ENVIRONMENT_LABEL: Record<Environment, MessageKey> = {
  dev: 'env.dev',
  test: 'env.test',
  stage: 'env.stage',
  prod: 'env.prod',
}

/**
 * Профили подключений: список стендов по средам слева, карточка выбранного справа.
 *
 * Пароль хранится только по явной галочке, поэтому автоподключение возможно
 * не для каждого профиля — интерфейс говорит об этом прямо, а не молчит.
 */
export function ConnectionScreen({ store, onStore, server, connection, activeProfileId, focusProfileId, onConnect, onDisconnect }: Props) {
  const { t } = useI18n()

  const [selectedId, setSelectedId] = useState<string | null>(activeProfileId ?? store.lastUsedId ?? store.profiles[0]?.id ?? null)
  const [draft, setDraft] = useState<ConnectionProfile | null>(null)
  const [busy, setBusy] = useState<'connect' | 'test' | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<ConnectionProfile | null>(null)

  const stored = useMemo(
    () => store.profiles.find((profile) => profile.id === selectedId) ?? null,
    [store.profiles, selectedId],
  )

  /**
   * Черновик перезагружается только при переходе на другой профиль.
   *
   * Читать его прямо из props было бы неверно: любое сохранение настроек —
   * например, галочки автоподключения — стирало бы несохранённые правки,
   * а «Добавить» сбрасывало бы только что созданный профиль.
   */
  const storeRef = useRef(store)
  storeRef.current = store

  useEffect(() => {
    if (selectedId === null) return
    const found = storeRef.current.profiles.find((profile) => profile.id === selectedId) ?? null
    setDraft(found ? { ...found } : null)
    setTestResult(null)
    setError(null)
  }, [selectedId])

  // Переход по шестерёнке или из переключателя открывает нужный профиль сразу.
  useEffect(() => {
    if (focusProfileId) setSelectedId(focusProfileId)
  }, [focusProfileId])

  const persist = useCallback((next: ConnectionStore) => {
    writeStore(next)
    onStore(next)
  }, [onStore])

  const groups = useMemo(() => byEnvironment(store.profiles), [store.profiles])
  const dirty = useMemo(
    () => (draft && stored ? JSON.stringify(draft) !== JSON.stringify(stored) : draft !== null),
    [draft, stored],
  )
  const isNew = draft !== null && stored === null

  const addProfile = useCallback(() => {
    const profile = blankProfile()
    setSelectedId(null)
    setDraft(profile)
    setTestResult(null)
    setError(null)
  }, [])

  const save = useCallback((profile: ConnectionProfile) => {
    const named: ConnectionProfile = {
      ...profile,
      name: profile.name.trim() || profile.url.trim(),
    }
    persist(upsertProfile(store, named))
    setSelectedId(named.id)
    setDraft({ ...named })
    return named
  }, [persist, store])

  const test = useCallback(async () => {
    if (!draft) return
    setBusy('test')
    setTestResult(null)
    setError(null)
    try {
      const info = await apiConnect(toConnection(draft))
      setTestResult({
        ok: true,
        text: t('profiles.test.ok', {
          user: info.user,
          domains: info.domains,
          version: info.apiVersion ?? '—',
        }),
      })
    } catch (err) {
      setTestResult({ ok: false, text: errorText(err) })
    } finally {
      setBusy(null)
    }
  }, [draft, t])

  const connect = useCallback(async () => {
    if (!draft) return
    // Подключаемся всегда к сохранённому профилю: иначе «последний использованный»
    // указывал бы на то, чего в списке нет.
    const profile = dirty || isNew ? save(draft) : draft
    setBusy('connect')
    setError(null)
    setTestResult(null)
    try {
      await onConnect(profile)
      persist(markUsed(upsertProfile(store, profile), profile.id, new Date().toISOString()))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }, [draft, dirty, isNew, save, onConnect, persist, store])

  const remove = useCallback(() => {
    if (!confirmDelete) return
    persist(removeProfile(store, confirmDelete.id))
    if (selectedId === confirmDelete.id) {
      setSelectedId(null)
      setDraft(null)
    }
    setConfirmDelete(null)
  }, [confirmDelete, persist, store, selectedId])

  // Enter в поле формы — та же кнопка «Подключиться», с теми же запретами:
  // без них он обходил и незаполненный логин, и уже идущее подключение.
  const submit = useCallback((event: FormEvent) => {
    event.preventDefault()
    if (draft && isReady(draft) && busy === null) void connect()
  }, [connect, draft, busy])

  const set = <K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  return (
    <ScreenBody>
      {server && (
        <ConnectedStrip
          server={server}
          profile={store.profiles.find((profile) => profile.id === activeProfileId) ?? null}
          onDisconnect={onDisconnect}
        />
      )}

      <ScreenBodyRow>
        <div className="flex w-72 shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-surface">
          <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-3 py-2">
            <span className="text-[11px] tracking-wide text-content-subtle">
              {t('profiles.title', { count: store.profiles.length })}
            </span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={addProfile}>
              {t('profiles.add')}
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {groups.map(([environment, profiles]) => (
              <div key={environment} className="mb-2">
                <div className="flex items-center gap-2 px-2.5 pb-1 pt-1.5">
                  <span className="text-[10.5px] font-semibold tracking-wide text-content-subtle">
                    {t(ENVIRONMENT_LABEL[environment])}
                  </span>
                  <span className="h-px flex-1 bg-line" />
                </div>
                {profiles.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    onClick={() => setSelectedId(profile.id)}
                    className={cx(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition',
                      profile.id === selectedId ? 'bg-accent/12' : 'hover:bg-surface-3',
                    )}
                  >
                    <span
                      className={cx(
                        'size-1.5 shrink-0 rounded-full',
                        profile.id === activeProfileId ? 'bg-positive' : 'bg-content-subtle/40',
                      )}
                      title={profile.id === activeProfileId ? t('profiles.activeHint') : undefined}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium">{profile.name}</span>
                      <span className="block truncate text-[10.5px] text-content-subtle">{profile.url}</span>
                    </span>
                  </button>
                ))}
              </div>
            ))}

            {store.profiles.length === 0 && (
              <p className="px-2.5 py-8 text-center text-[11.5px] leading-relaxed text-content-subtle">
                {t('profiles.none')}
              </p>
            )}
          </div>

          <div className="border-t border-line px-3 py-2.5">
            <label
              className="flex cursor-pointer items-start gap-2 text-[11.5px] leading-relaxed text-content-muted"
              title={t('profiles.autoConnect.hint')}
            >
              <Checkbox
                className="mt-0.5"
                checked={store.autoConnect}
                onChange={(event) => persist({ ...store, autoConnect: event.target.checked })}
              />
              {t('profiles.autoConnect')}
            </label>
            {store.autoConnect && !canAutoConnect(store) && (
              <p className="mt-1.5 text-[10.5px] leading-relaxed text-caution">{t('profiles.autoConnect.blocked')}</p>
            )}
          </div>
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {draft ? (
            <form onSubmit={submit} className="rounded-xl border border-line bg-surface">
              <div className="flex items-center gap-2 border-b border-line px-5 py-3">
                <span className="text-[13px] font-semibold">
                  {isNew ? t('profiles.newProfile') : draft.name || t('profiles.unnamed')}
                </span>
                <Badge tone={ENVIRONMENT_TONE[draft.environment]}>{t(ENVIRONMENT_LABEL[draft.environment])}</Badge>
                {dirty && <Badge tone="warn">{t('profiles.unsaved')}</Badge>}
                {!isNew && draft.lastUsedAt && (
                  <span className="ml-auto text-[11px] text-content-subtle">
                    {t('profiles.lastUsed', { when: formatWhen(draft.lastUsedAt) })}
                  </span>
                )}
              </div>

              {/* Четыре среды подряд («Разработка … Прод») шире половины
                  формы на узком окне, и «Прод» уезжал за край. Пока места
                  мало — поля идут друг под другом. */}
              <div className="grid grid-cols-1 gap-3 px-5 pt-4 xl:grid-cols-2">
                <Field label={t('profiles.name')} htmlFor="profile-name">
                  <TextInput
                    id="profile-name"
                    value={draft.name}
                    placeholder={t('profiles.namePlaceholder')}
                    onChange={(event) => set('name', event.target.value)}
                  />
                </Field>
                <Field label={t('profiles.environment')} htmlFor="profile-env">
                  <Segmented<Environment>
                    ariaLabel={t('profiles.environment')}
                    value={draft.environment}
                    onChange={(value) => set('environment', value)}
                    options={[
                      { id: 'dev', label: t('env.dev') },
                      { id: 'test', label: t('env.test') },
                      { id: 'stage', label: t('env.stage') },
                      { id: 'prod', label: t('env.prod') },
                    ]}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 px-5 pt-3">
                <Field label={t('api.url')} htmlFor="profile-url" hint={t('api.url.hint')}>
                  <TextInput
                    id="profile-url"
                    value={draft.url}
                    autoComplete="url"
                    placeholder="localhost:8181"
                    onChange={(event) => set('url', event.target.value)}
                  />
                </Field>
                <Field label={t('api.user')} htmlFor="profile-user">
                  <TextInput
                    id="profile-user"
                    value={draft.username}
                    autoComplete="username"
                    onChange={(event) => set('username', event.target.value)}
                  />
                </Field>
                <Field label={t('api.password')} htmlFor="profile-password">
                  <TextInput
                    id="profile-password"
                    type="password"
                    value={draft.password}
                    autoComplete="current-password"
                    onChange={(event) => set('password', event.target.value)}
                  />
                </Field>
              </div>

              <div className="flex flex-wrap items-center gap-2 px-5 pt-3">
                <Toggle
                  checked={draft.rememberPassword}
                  onChange={(value) => set('rememberPassword', value)}
                  label={t('api.remember')}
                  title={t('api.remember.hint')}
                />
                <Toggle
                  checked={draft.insecure}
                  onChange={(value) => set('insecure', value)}
                  label={t('api.insecure')}
                  title={t('api.insecure.hint')}
                />
              </div>

              {draft.environment === 'prod' && (
                <Notice tone="danger" small className="mx-5 mt-3">
                  {t('profiles.prodWarning')}
                </Notice>
              )}

              {testResult && (
                <Notice tone={testResult.ok ? 'ok' : 'danger'} small className="mx-5 mt-3">
                  {testResult.text}
                </Notice>
              )}

              {error && (
                <Notice tone="danger" small className="mx-5 mt-3">
                  {error}
                </Notice>
              )}

              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
                {!isNew && (
                  <Button variant="ghost" onClick={() => stored && setConfirmDelete(stored)}>
                    {t('profiles.delete')}
                  </Button>
                )}

                <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                  <Button className="min-w-36" onClick={() => void test()} disabled={!isReady(draft) || busy !== null}>
                    {busy === 'test' ? <><Spinner className="size-4" /> {t('profiles.testing')}</> : t('profiles.test')}
                  </Button>
                  <Button onClick={() => save(draft)} disabled={!dirty || draft.url.trim() === ''}>
                    {t('profiles.save')}
                  </Button>
                  {/* Скрытая кнопка нужна, чтобы работал Enter в полях формы. */}
                  <button type="submit" hidden aria-hidden tabIndex={-1} />
                  <Button variant="primary" className="min-w-36" onClick={() => void connect()} disabled={!isReady(draft) || busy !== null}>
                    {busy === 'connect'
                      ? <><Spinner className="size-4" /> {t('api.connecting')}</>
                      : t('api.connect')}
                  </Button>
                </div>
              </div>
            </form>
          ) : (
            <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-line-strong bg-surface/60 px-8 py-12 text-center">
              <div className="max-w-md">
                <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-surface-2 text-accent-content">
          <ArrowsLeftRight size={24} weight="regular" />
        </div>
                <h2 className="mt-4 text-[15px] font-semibold">{t('profiles.pick')}</h2>
                <p className="mt-2 text-[12.5px] leading-relaxed text-content-subtle">{t('api.intro')}</p>
                <Button variant="primary" className="mt-5" onClick={addProfile}>{t('profiles.add')}</Button>
              </div>
            </div>
          )}

          {server && connection && <ServerCard server={server} connection={connection} />}
        </div>
      </ScreenBodyRow>

      <Modal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        closeLabel={t('action.close')}
        title={t('profiles.confirmDelete')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>{t('action.cancel')}</Button>
            <Button variant="primary" onClick={remove}>{t('profiles.delete')}</Button>
          </>
        }
      >
        {confirmDelete && (
          <div className="space-y-3 text-[13px] leading-relaxed">
            <code className="block break-all rounded bg-accent/12 px-2 py-1 font-mono text-accent-content">
              {confirmDelete.name} · {confirmDelete.url}
            </code>
            <p className="text-content-muted">{t('profiles.confirmDeleteText')}</p>
          </div>
        )}
      </Modal>
    </ScreenBody>
  )
}

/** Строка текущего подключения — она же кнопка «отключиться». */
function ConnectedStrip({ server, profile, onDisconnect }: {
  server: ServerInfo
  profile: ConnectionProfile | null
  onDisconnect: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="flex items-center gap-2 rounded-xl border border-positive/35 bg-positive/8 px-4 py-2.5">
      <span className="grid size-6 place-items-center rounded-full bg-positive/15 text-positive"><Check size={13} weight="bold" /></span>
      <span className="text-[13px] font-semibold">{profile?.name ?? t('api.connected')}</span>
      {profile && <Badge tone={ENVIRONMENT_TONE[profile.environment]}>{t(ENVIRONMENT_LABEL[profile.environment])}</Badge>}
      {server.apiVersion && <Badge tone="accent" className="font-mono">FESB {server.apiVersion}</Badge>}
      <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-content-subtle">
        {server.baseUrl} · {server.user}
      </code>
      <Button size="sm" onClick={onDisconnect}>{t('profiles.disconnect')}</Button>
    </div>
  )
}

/**
 * Подробности **текущего** подключения, а не выбранного в списке профиля.
 * Разница неочевидна, когда рядом открыта форма другого стенда, — поэтому
 * у карточки есть заголовок с адресом.
 */
function ServerCard({ server, connection }: { server: ServerInfo; connection: Connection }) {
  const { t } = useI18n()
  const running = server.modules.filter((item) => item.running).length

  return (
    <div className="mt-3 rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-5 py-2.5">
        <span className="text-[11px] tracking-wide text-content-subtle">{t('profiles.serverDetails')}</span>
        <code className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-content-subtle">
          {server.baseUrl}
        </code>
      </div>
      <div className="grid grid-cols-4 gap-4 px-5 py-4">
        <TextReadout label={t('api.info.user')} value={server.user} />
        <TextReadout label={t('api.info.roles')} value={server.roles.join(', ') || '—'} />
        <TextReadout label={t('api.info.permissions')} value={String(server.permissions)} />
        <TextReadout label={t('api.info.domains')} value={`${server.domains} · ${t('api.info.active', { count: server.activeDomains })}`} />
      </div>

      {server.missingPermissions.length > 0 && (
        <Notice tone="warn" small className="mx-5 mb-4">
          {t('api.missingPermissions', { list: server.missingPermissions.join(', ') })}
        </Notice>
      )}

      <ServerState connection={connection} />

      <div className="border-t border-line px-5 py-3">
        <div className="mb-2 text-[11px] tracking-wide text-content-subtle">
          {t('api.modules', { running, total: server.modules.length })}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {server.modules.map((module) => (
            <span
              key={module.name}
              title={module.name}
              className={cx(
                'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px]',
                module.running
                  ? 'border-positive/35 bg-positive/10 text-positive'
                  : 'border-line-strong bg-surface-2 text-content-subtle',
              )}
            >
              <span className={cx('size-1.5 rounded-full', module.running ? 'bg-positive' : 'bg-content-subtle/50')} />
              {module.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Автоподключение возможно только с сохранённым паролем. */
function canAutoConnect(store: ConnectionStore): boolean {
  const profile = store.profiles.find((item) => item.id === store.lastUsedId)
  return Boolean(profile?.rememberPassword && profile.password)
}

/** `2026-08-26T18:11:26` → `26.08 18:11`. */
function formatWhen(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2})/.exec(value)
  return match ? `${match[3]}.${match[2]} ${match[4]}` : value
}


function Field({ label, htmlFor, hint, children }: {
  label: string
  htmlFor: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="min-w-0">
      <label className="mb-1.5 block text-[11px] tracking-wide text-content-subtle" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <p className="mt-1 truncate text-[10.5px] text-content-subtle" title={hint}>{hint}</p>}
    </div>
  )
}

/**
 * Состояние самой шины: сколько работает, чем занята память, сколько
 * осталось на дисках.
 *
 * Живёт здесь, а не отдельным разделом, потому что отвечает на тот же
 * вопрос, что и вся карточка, — «что это за сервер». Читается отдельным
 * запросом: подключение проверять этим не нужно, и если прав не хватило,
 * остальная карточка от этого не страдает.
 */
function ServerState({ connection }: { connection: Connection }) {
  const { t } = useI18n()
  const load = useCallback((open: Connection) => apiServerUsage(open), [])
  const { data } = useApiData<ServerUsage>(connection, load)
  if (!data) return null

  const memory = data.memoryUsed !== null && data.memoryMax !== null
    ? `${formatBytes(data.memoryUsed)} / ${formatBytes(data.memoryMax)}`
    : '—'

  return (
    <div className="border-t border-line px-5 py-4">
      <div className="mb-3 text-[11px] tracking-wide text-content-subtle">{t('server.state')}</div>
      <div className="grid grid-cols-4 gap-4">
        <TextReadout
          label={t('server.uptime')}
          value={data.uptime === null ? '—' : formatUptime(data.uptime, t)}
        />
        <TextReadout label={t('server.memory')} value={memory} hint={t('server.memory.hint')} />
        <TextReadout
          label={t('server.cpu')}
          value={data.processorUsage === null ? '—' : formatShare(data.processorUsage)}
          hint={data.processors ? t('server.cpu.hint', { count: data.processors }) : undefined}
        />
        <TextReadout label={t('server.os')} value={data.os ?? '—'} />
        <TextReadout label={t('server.jvm')} value={data.jvm ?? '—'} />
        <TextReadout label={t('server.path')} value={data.path ?? '—'} />
        <TextReadout
          label={t('server.addresses')}
          value={data.addresses.join(', ') || '—'}
        />
      </div>

      {data.disks.length > 0 && (
        <>
          <div className="mb-2 mt-4 text-[11px] tracking-wide text-content-subtle">{t('server.disks')}</div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 xl:grid-cols-3">
            {data.disks.map((disk) => (
              <Disk key={`${disk.name}-${disk.path ?? ''}`} disk={disk} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Один диск или каталог полосой.
 *
 * Полоса важнее цифр: «занято 3.3 GB из 910 GB» надо считать в уме,
 * а полоса отвечает сразу. Красной она становится там, где место
 * действительно кончается.
 */
function Disk({ disk }: { disk: DiskUsage }) {
  const { t } = useI18n()
  const share = disk.total > 0 ? disk.used / disk.total : 0
  return (
    <div title={disk.path ?? disk.name}>
      <div className="flex items-baseline gap-2 text-[11.5px]">
        <span className="min-w-0 truncate font-medium">{disk.name}</span>
        <span className="ml-auto shrink-0 tabular-nums text-content-subtle">
          {formatBytes(disk.free)} {t('server.disk.free')}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div
          className={cx(
            'h-full rounded-full',
            share > 0.9 ? 'bg-negative' : share > 0.75 ? 'bg-caution' : 'bg-accent',
          )}
          style={{ width: `${Math.max(share * 100, 1)}%` }}
        />
      </div>
    </div>
  )
}
