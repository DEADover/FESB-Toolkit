import { useCallback, useState, type FormEvent } from 'react'

import { useI18n } from '../i18n'
import { apiConnect, errorText } from '../lib/api'
import { forgetConnection, storeConnection, toConnection, type StoredConnection } from '../lib/connection'
import type { Connection, ServerInfo } from '../types'
import { Badge, Button, Checkbox, Spinner, TextInput, cx } from './ui'

interface Props {
  form: StoredConnection
  onForm: (form: StoredConnection) => void
  server: ServerInfo | null
  onServer: (server: ServerInfo | null, connection: Connection | null) => void
}

/** Экран подключения: адрес шины, учётная запись и то, что о ней известно. */
export function ConnectionScreen({ form, onForm, server, onServer }: Props) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connect = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const connection = toConnection(form)
      const info = await apiConnect(connection)
      storeConnection(form)
      onServer(info, connection)
    } catch (err) {
      onServer(null, null)
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [form, onServer])

  const submit = useCallback((event: FormEvent) => {
    event.preventDefault()
    void connect()
  }, [connect])

  const disconnect = useCallback(() => {
    onServer(null, null)
    setError(null)
  }, [onServer])

  const set = <K extends keyof StoredConnection>(key: K, value: StoredConnection[K]) =>
    onForm({ ...form, [key]: value })

  const ready = form.url.trim().length > 0 && form.username.trim().length > 0

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <form onSubmit={submit} className="rounded-xl border border-line bg-surface p-5">
          <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3">
            <Field label={t('api.url')} htmlFor="api-url" hint={t('api.url.hint')}>
              <TextInput
                id="api-url"
                value={form.url}
                autoComplete="url"
                placeholder="http://localhost:8181/manager"
                onChange={(event) => set('url', event.target.value)}
              />
            </Field>
            <Field label={t('api.user')} htmlFor="api-user">
              <TextInput
                id="api-user"
                value={form.username}
                autoComplete="username"
                onChange={(event) => set('username', event.target.value)}
              />
            </Field>
            <Field label={t('api.password')} htmlFor="api-password">
              <TextInput
                id="api-password"
                type="password"
                value={form.password}
                autoComplete="current-password"
                onChange={(event) => set('password', event.target.value)}
              />
            </Field>
          </div>

          <div className="mt-4 flex items-center gap-2 border-t border-line pt-3">
            <Toggle
              checked={form.rememberPassword}
              onChange={(value) => set('rememberPassword', value)}
              label={t('api.remember')}
              title={t('api.remember.hint')}
            />
            <Toggle
              checked={form.insecure}
              onChange={(value) => set('insecure', value)}
              label={t('api.insecure')}
              title={t('api.insecure.hint')}
            />

            <div className="ml-auto flex items-center gap-2">
              {server && (
                <Button
                  variant="ghost"
                  onClick={() => { forgetConnection(); disconnect() }}
                >
                  {t('api.forget')}
                </Button>
              )}
              {/* Скрытая кнопка нужна, чтобы работал Enter в полях формы. */}
              <button type="submit" hidden aria-hidden tabIndex={-1} />
              <Button variant="primary" onClick={() => void connect()} disabled={!ready || busy}>
                {busy ? <><Spinner className="size-4" /> {t('api.connecting')}</> : t('api.connect')}
              </Button>
            </div>
          </div>
        </form>

        {error && (
          <div className="rounded-xl border border-negative/40 bg-negative/10 px-4 py-3 text-negative">{error}</div>
        )}

        {server && <ServerCard server={server} />}

        {!server && !error && (
          <p className="px-1 text-[11.5px] leading-relaxed text-content-subtle">{t('api.intro')}</p>
        )}
      </div>
    </div>
  )
}

function ServerCard({ server }: { server: ServerInfo }) {
  const { t } = useI18n()
  const running = server.modules.filter((item) => item.running).length

  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <span className="grid size-6 place-items-center rounded-full bg-positive/15 text-[12px] text-positive">✓</span>
        <span className="text-[13px] font-semibold">{t('api.connected')}</span>
        {server.apiVersion && <Badge tone="accent" className="font-mono">FESB {server.apiVersion}</Badge>}
        <code className="ml-auto truncate font-mono text-[11.5px] text-content-subtle">{server.baseUrl}</code>
      </div>

      <div className="grid grid-cols-4 gap-4 px-5 py-4">
        <Info label={t('api.info.user')} value={server.user} />
        <Info label={t('api.info.roles')} value={server.roles.join(', ') || '—'} />
        <Info label={t('api.info.permissions')} value={String(server.permissions)} />
        <Info label={t('api.info.domains')} value={`${server.domains} · ${t('api.info.active', { count: server.activeDomains })}`} />
      </div>

      {server.missingPermissions.length > 0 && (
        <p className="mx-5 mb-4 rounded-lg border border-caution/35 bg-caution/10 px-3 py-2 text-[11.5px] text-caution">
          {t('api.missingPermissions', { list: server.missingPermissions.join(', ') })}
        </p>
      )}

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

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] tracking-wide text-content-subtle">{label}</div>
      <div className="truncate text-[13px] font-medium" title={value}>{value}</div>
    </div>
  )
}

function Field({ label, htmlFor, hint, children }: {
  label: string
  htmlFor: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="min-w-0">
      <label className="mb-1.5 block text-[11px] tracking-wide text-content-subtle" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <p className="mt-1 truncate text-[10.5px] text-content-subtle" title={hint}>{hint}</p>}
    </div>
  )
}

function Toggle({ checked, onChange, label, title }: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  title?: string
}) {
  return (
    <label
      title={title}
      className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 text-[12.5px] text-content-muted"
    >
      <Checkbox checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  )
}
