import { useCallback, useEffect, useMemo, useState } from 'react'

import { ArrowRight, CaretDown, CaretRight, Copy } from '@phosphor-icons/react'

import { useI18n } from '../i18n'
import { apiCopyPlan, apiCopyRun, errorText } from '../lib/api'
import { connectionWith, type ConnectionStore } from '../lib/connection'
import { formatBytes } from '../lib/format'
import type { ApiDomain, Connection, CopyDomain, CopyPlan, CopyResult, RouteChange, ServerInfo } from '../types'
import { Badge, Button, ButtonGlyph, Checkbox, cx, Modal, Notice, Select, Spinner, TextInput } from './ui'

interface Props {
  open: boolean
  onClose: () => void
  connection: Connection
  server: ServerInfo
  store: ConnectionStore
  activeProfileId: string | null
  domains: ApiDomain[]
  /** Стенд, выбранный заранее, — когда копирование открыли из сравнения. */
  initialTargetId?: string | null
  initialPassword?: string
}

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'

const CHANGE_TONE: Record<RouteChange, Tone> = {
  added: 'ok',
  changed: 'accent',
  removed: 'danger',
  same: 'neutral',
}

/**
 * Копирование выбранных доменов на другой сервер.
 *
 * Сначала сравнение: домены забираются в память и сверяются с целевым
 * сервером, и до нажатия «Копировать» там ничего не меняется. Загружается
 * ровно то, что показано, — второй раз домены не выгружаются.
 *
 * Целевой сервер — любой сохранённый стенд, кроме открытого. Пароль
 * спрашивается здесь же, если он не запомнен, и нигде не сохраняется.
 */
export function CopyDomainsDialog({
  open, onClose, connection, server, store, activeProfileId, domains, initialTargetId = null, initialPassword = '',
}: Props) {
  const { t } = useI18n()
  const [targetId, setTargetId] = useState<string | null>(initialTargetId)
  const [password, setPassword] = useState(initialPassword)
  const [plan, setPlan] = useState<CopyPlan | null>(null)
  const [result, setResult] = useState<CopyResult | null>(null)
  const [busy, setBusy] = useState<'plan' | 'run' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [removeMissing, setRemoveMissing] = useState(true)
  const [reload, setReload] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const others = useMemo(
    () => store.profiles.filter((profile) => profile.id !== activeProfileId),
    [store.profiles, activeProfileId],
  )
  const target = others.find((profile) => profile.id === targetId) ?? null
  const needsPassword = target !== null && !target.rememberPassword && !password
  const prod = target?.environment === 'prod'

  // Каждое открытие — новая операция: прошлое сравнение к новому выбору доменов не относится.
  useEffect(() => {
    if (!open) return
    setPlan(null)
    setResult(null)
    setError(null)
    setExpanded(new Set())
  }, [open])

  const reset = useCallback(() => { setPlan(null); setResult(null); setError(null) }, [])

  const compare = useCallback(async () => {
    if (!target) return
    setBusy('plan')
    setError(null)
    setPlan(null)
    try {
      const next = await apiCopyPlan(connection, connectionWith(target, password), domains.map((item) => item.guid))
      setPlan(next)
      // Сразу раскрыты домены, в которых что-то пропадёт: это то, что нельзя пропустить.
      setExpanded(new Set(next.domains.filter((item) => item.routes.some((route) => route.change === 'removed')).map((item) => item.guid)))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }, [connection, target, password, domains])

  const run = useCallback(async () => {
    if (!target || !plan) return
    setBusy('run')
    setError(null)
    try {
      setResult(await apiCopyRun(connectionWith(target, password), plan.id, reload, removeMissing))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }, [target, plan, password, reload, removeMissing])

  const totals = useMemo(() => {
    const count = { added: 0, changed: 0, removed: 0, same: 0 }
    for (const domain of plan?.domains ?? []) {
      for (const route of domain.routes) count[route.change] += 1
    }
    return count
  }, [plan])

  const versionDiffers = plan !== null && !!server.apiVersion && !!plan.target.apiVersion
    && server.apiVersion !== plan.target.apiVersion
  const failed = result?.domains.filter((item) => item.error) ?? []

  const footer = result ? (
    <Button variant="primary" onClick={onClose}>{t('action.close')}</Button>
  ) : (
    <>
      <Button variant="ghost" onClick={onClose} disabled={busy === 'run'}>{t('action.cancel')}</Button>
      {plan ? (
        <Button variant={prod ? 'danger' : 'primary'} className="min-w-36" disabled={busy !== null} onClick={() => void run()}>
          <ButtonGlyph busy={busy === 'run'}><Copy size={14} weight="bold" /></ButtonGlyph>
          {t('copy.run', { count: plan.domains.length })}
        </Button>
      ) : (
        <Button variant="primary" className="min-w-36" disabled={!target || needsPassword || busy !== null} onClick={() => void compare()}>
          <ButtonGlyph busy={busy === 'plan'}><ArrowRight size={14} weight="bold" /></ButtonGlyph>
          {t('copy.compare')}
        </Button>
      )}
    </>
  )

  return (
    <Modal
      open={open}
      onClose={() => busy !== 'run' && onClose()}
      closeLabel={t('action.close')}
      title={t('copy.title')}
      width="wide"
      footer={footer}
    >
      <div className="space-y-3 text-[13px] leading-relaxed">
        {!result && (
          <p className="text-content-muted">{t('copy.intro', { count: domains.length })}</p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">{server.baseUrl}</Badge>
          <ArrowRight size={14} className="text-content-subtle" />
          <Select<string>
            ariaLabel={t('copy.target')}
            label={t('copy.target')}
            className="w-80"
            value={targetId ?? ''}
            onChange={(id) => { setTargetId(id || null); setPassword(''); reset() }}
            options={[
              { id: '', label: t('copy.pick') },
              ...others.map((profile) => ({ id: profile.id, label: profile.name, hint: t(`env.${profile.environment}`) })),
            ]}
          />
          {target && !target.rememberPassword && (
            <div className="w-44">
              <TextInput
                type="password"
                value={password}
                placeholder={t('api.password')}
                disabled={result !== null}
                onChange={(event) => { setPassword(event.target.value); reset() }}
              />
            </div>
          )}
        </div>

        {others.length === 0 && <Notice tone="warn">{t('copy.noOthers')}</Notice>}
        {prod && !result && (
          <Notice tone="warn">{t('copy.prod')}{reload && plan?.domains.some((item) => item.exists) ? ` ${t('copy.prod.reload')}` : ''}</Notice>
        )}
        {error && <Notice tone="danger">{error}</Notice>}

        {plan && !result && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-content-muted">
              <span>{t('copy.summary.domains', { count: plan.domains.length })}</span>
              <span>·</span>
              <span>{formatBytes(plan.bytes)}</span>
              <span className="mx-1 h-4 w-px bg-line" />
              <Badge tone="ok">{t('copy.change.added')}: {totals.added}</Badge>
              <Badge tone="accent">{t('copy.change.changed')}: {totals.changed}</Badge>
              <Badge tone={removeMissing && totals.removed > 0 ? 'danger' : 'neutral'}>
                {removeMissing ? t('copy.change.removed') : t('copy.change.kept')}: {totals.removed}
              </Badge>
              <Badge>{t('copy.change.same')}: {totals.same}</Badge>
            </div>

            {versionDiffers && (
              <Notice tone="warn">
                {t('copy.version', { source: server.apiVersion ?? '', target: plan.target.apiVersion ?? '' })}
              </Notice>
            )}

            <div className="max-h-[42vh] overflow-y-auto rounded-lg border border-line">
              {plan.domains.map((domain) => (
                <DomainRow
                  key={domain.guid}
                  domain={domain}
                  removeMissing={removeMissing}
                  open={expanded.has(domain.guid)}
                  onToggle={() => setExpanded((prev) => {
                    const next = new Set(prev)
                    if (next.has(domain.guid)) next.delete(domain.guid)
                    else next.add(domain.guid)
                    return next
                  })}
                />
              ))}
            </div>

            <div className="space-y-2">
              <label className="flex cursor-pointer items-start gap-2">
                <Checkbox className="mt-[3px]" checked={removeMissing} onChange={(event) => setRemoveMissing(event.target.checked)} />
                <span>
                  {t('copy.option.removeMissing')}
                  <span className="block text-[11.5px] text-content-subtle">{t('copy.option.removeMissing.hint')}</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2">
                <Checkbox className="mt-[3px]" checked={reload} onChange={(event) => setReload(event.target.checked)} />
                <span>
                  {t('copy.option.reload')}
                  <span className="block text-[11.5px] text-content-subtle">{t('copy.option.reload.hint')}</span>
                </span>
              </label>
            </div>
          </>
        )}

        {busy === 'run' && (
          <div className="flex items-center gap-2 text-content-muted">
            <Spinner className="size-4" /> {t('copy.running')}
          </div>
        )}

        {result && (
          <>
            <Notice tone={failed.length > 0 ? 'warn' : 'ok'}>
              {failed.length > 0
                ? t('copy.done.partly', { failed: failed.length, total: result.domains.length })
                : t('copy.done', { count: result.domains.length, target: target?.name ?? '' })}
            </Notice>
            <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
              {result.domains.map((item) => (
                <div key={item.guid} className="flex items-center gap-2 border-b border-line/60 px-3 py-1.5 last:border-b-0">
                  <span className={cx('size-1.5 shrink-0 rounded-full', item.error ? 'bg-negative' : 'bg-positive')} />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  <span className="min-w-0 max-w-[60%] truncate text-[11px] text-content-subtle" title={item.error ?? item.message ?? undefined}>
                    {item.error ?? item.message ?? t('copy.loaded')}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

function DomainRow({ domain, removeMissing, open, onToggle }: {
  domain: CopyDomain
  removeMissing: boolean
  open: boolean
  onToggle: () => void
}) {
  const { t } = useI18n()
  const touched = domain.routes.filter((route) => route.change !== 'same')
  const unchanged = domain.exists && touched.length === 0 && !domain.settingsChanged
  const state = !domain.exists ? 'new' : unchanged ? 'same' : 'overwrite'
  const Caret = open ? CaretDown : CaretRight

  return (
    <div className="border-b border-line/60 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-surface-2"
      >
        <Caret size={12} className="shrink-0 text-content-subtle" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{domain.name}</span>
          <span className="block truncate font-mono text-[10.5px] text-content-subtle">{domain.guid}</span>
        </span>
        {domain.settingsChanged && <Badge>{t('copy.settingsChanged')}</Badge>}
        {domain.exists && domain.activeOnTarget && <Badge tone="ok">{t('copy.activeOnTarget')}</Badge>}
        <Badge tone={state === 'new' ? 'ok' : state === 'same' ? 'neutral' : 'warn'}>{t(`copy.state.${state}`)}</Badge>
      </button>

      {(domain.nameTakenBy || domain.targetName) && (
        <div className="space-y-1 px-8 pb-2 text-[11.5px] text-caution">
          {domain.nameTakenBy && <p>{t('copy.nameTaken', { guid: domain.nameTakenBy })}</p>}
          {domain.targetName && <p>{t('copy.renamed', { name: domain.targetName })}</p>}
        </div>
      )}

      {open && (
        <div className="px-8 pb-2">
          {domain.routes.length === 0 && <p className="text-[11.5px] text-content-subtle">{t('copy.noRoutes')}</p>}
          {domain.routes.map((route) => {
            const kept = route.change === 'removed' && !removeMissing
            return (
              <div key={route.id} className="flex items-center gap-2 py-0.5 text-[12px]">
                <span className={cx('min-w-0 flex-1 truncate', route.change === 'same' && 'text-content-subtle')}>
                  {route.name ?? route.id}
                </span>
                <Badge tone={kept ? 'neutral' : CHANGE_TONE[route.change]}>
                  {t(kept ? 'copy.change.kept' : `copy.change.${route.change}`)}
                </Badge>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
