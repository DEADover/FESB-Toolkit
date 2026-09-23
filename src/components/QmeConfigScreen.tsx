import { useCallback, useEffect, useMemo, useState } from 'react'

import { ArrowsClockwise, FloppyDisk } from '@phosphor-icons/react'

import { useI18n, type MessageKey } from '../i18n'
import { apiQmeConfig, apiQmeStore, apiQueueManagers, errorText } from '../lib/api'
import type { Environment } from '../lib/connection'
import type { Connection, QmeConfigAudit, QmeConfigItem, QmeConfigKind, QmeStoreOutcome, QueueManager, ServerInfo } from '../types'
import { ErrorBar, NotConnected, Panel, ScreenBody, StatsBar, TableMessage } from './ApiShell'
import {
  Badge, Button, ButtonGlyph, Checkbox, cx, DataTable, Modal, Notice, Readout, SearchInput, Segmented, Select, Spinner,
  TextInput, Th, THead, Toggle,
} from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  /** Среда открытого стенда: на продуктиве запись подтверждается отдельно. */
  environment: Environment | null
  onGoToConnection: () => void
}

/** Порядок разделов — как в меню РМО веб-интерфейса FESB. */
const KINDS: QmeConfigKind[] = ['queue', 'address', 'divert', 'addressSetting', 'security', 'user']

const KIND_LABEL: Record<QmeConfigKind, MessageKey> = {
  queue: 'qmeConfig.kind.queue',
  address: 'qmeConfig.kind.address',
  divert: 'qmeConfig.kind.divert',
  addressSetting: 'qmeConfig.kind.addressSetting',
  security: 'qmeConfig.kind.security',
  user: 'qmeConfig.kind.user',
}

const key = (item: { kind: QmeConfigKind; id: string }) => `${item.kind}\u0000${item.id}`

/**
 * Какие объекты расширенного менеджера очередей хранятся в конфигурации.
 *
 * Объект без галочки «Хранить в конфигурации» живёт только в журнале брокера
 * и не переедет вместе с конфигурацией на другой стенд. Экран собирает такие
 * объекты из шести разделов РМО в одну таблицу, чтобы пройти по ним и решить,
 * что сохранять.
 *
 * Сохранение учитывает две вещи, проверенные на стенде: очередь записывается,
 * только если записан её адрес, — поэтому адрес добавляется сам; а пароль
 * пользователя шина не отдаёт — поэтому его вводят заново.
 */
export function QmeConfigScreen({ connection, server, environment, onGoToConnection }: Props) {
  const { t } = useI18n()
  const [managers, setManagers] = useState<QueueManager[] | null>(null)
  const [managerId, setManagerId] = useState<string | null>(null)
  const [audit, setAudit] = useState<QmeConfigAudit | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<QmeConfigKind | 'all'>('all')
  const [onlyLoose, setOnlyLoose] = useState(true)
  const [showSystem, setShowSystem] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [passwords, setPasswords] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [outcomes, setOutcomes] = useState<QmeStoreOutcome[] | null>(null)

  // Менеджеры: нужны только расширенные, у мультименеджера этой галочки нет.
  useEffect(() => {
    if (!connection || !server) return
    let alive = true
    apiQueueManagers(connection)
      .then((list) => {
        if (!alive) return
        const qme = list.filter((item) => item.kind === 'QME')
        setManagers(qme)
        setManagerId((current) => current ?? qme.find((item) => item.running)?.id ?? qme[0]?.id ?? null)
      })
      .catch((err) => alive && setError(errorText(err)))
    return () => { alive = false }
  }, [connection, server])

  const load = useCallback(async () => {
    if (!connection || !managerId) return
    setLoading(true)
    setError(null)
    try {
      setAudit(await apiQmeConfig(connection, managerId))
    } catch (err) {
      setError(errorText(err))
      setAudit(null)
    } finally {
      setLoading(false)
    }
  }, [connection, managerId])

  useEffect(() => {
    setSelected(new Set())
    void load()
  }, [load])

  const items = useMemo(() => audit?.items ?? [], [audit])
  const byKey = useMemo(() => new Map(items.map((item) => [key(item), item])), [items])
  const storedAddresses = useMemo(
    () => new Set(items.filter((item) => item.kind === 'address' && item.stored).map((item) => item.id)),
    [items],
  )

  const counted = useMemo(() => {
    const count = Object.fromEntries(KINDS.map((item) => [item, { total: 0, loose: 0 }])) as Record<QmeConfigKind, { total: number; loose: number }>
    for (const item of items) {
      if (item.system && !showSystem) continue
      count[item.kind].total += 1
      if (!item.stored) count[item.kind].loose += 1
    }
    return count
  }, [items, showSystem])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return items
      .filter((item) => showSystem || !item.system)
      .filter((item) => kind === 'all' || item.kind === kind)
      .filter((item) => !onlyLoose || !item.stored)
      .filter((item) => !needle
        || item.id.toLowerCase().includes(needle)
        || (item.detail ?? '').toLowerCase().includes(needle))
      .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.id.localeCompare(b.id))
  }, [items, showSystem, kind, onlyLoose, query])

  const selectable = visible.filter((item) => !item.stored)
  const allChosen = selectable.length > 0 && selectable.every((item) => selected.has(key(item)))

  /**
   * Что уйдёт на запись: выбранное плюс адреса выбранных очередей, которых
   * нет в конфигурации, — без адреса очередь не запишется.
   */
  const plan = useMemo(() => {
    const chosen = [...selected].map((id) => byKey.get(id)).filter((item): item is QmeConfigItem => !!item && !item.stored)
    const chosenKeys = new Set(chosen.map(key))
    const added: QmeConfigItem[] = []
    for (const item of chosen) {
      if (item.kind !== 'queue' || !item.address || storedAddresses.has(item.address)) continue
      const address = byKey.get(key({ kind: 'address', id: item.address }))
      if (address && !chosenKeys.has(key(address))) {
        chosenKeys.add(key(address))
        added.push(address)
      }
    }
    return { chosen, added }
  }, [selected, byKey, storedAddresses])

  const users = plan.chosen.filter((item) => item.kind === 'user')
  const missingPassword = users.some((item) => !passwords[item.id])

  const toggle = (item: QmeConfigItem) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(key(item))) next.delete(key(item))
    else next.add(key(item))
    return next
  })

  const save = useCallback(async () => {
    if (!connection || !managerId) return
    setSaving(true)
    try {
      const requests = [...plan.added, ...plan.chosen].map((item) => ({
        kind: item.kind,
        id: item.id,
        password: item.kind === 'user' ? passwords[item.id] ?? null : null,
      }))
      setOutcomes(await apiQmeStore(connection, managerId, requests))
      setConfirming(false)
      setSelected(new Set())
      setPasswords({})
      await load()
    } catch (err) {
      setError(errorText(err))
      setConfirming(false)
    } finally {
      setSaving(false)
    }
  }, [connection, managerId, plan, passwords, load])

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  const loose = items.filter((item) => !item.stored && (showSystem || !item.system)).length
  const total = items.filter((item) => showSystem || !item.system).length

  return (
    <ScreenBody>
      <StatsBar>
        {audit ? (
          <>
            <Readout label={t('qmeConfig.total')} value={String(total)} />
            <Readout label={t('qmeConfig.loose')} value={String(loose)} tone={loose > 0 ? 'warn' : undefined} hint={t('qmeConfig.loose.hint')} />
            <span className="text-[12px] text-content-muted">{t('qmeConfig.intro')}</span>
          </>
        ) : (
          <span className="text-[12px] text-content-muted">{t('qmeConfig.intro')}</span>
        )}
      </StatsBar>

      <div className="flex flex-wrap items-center gap-2">
        <Select<string>
          ariaLabel={t('qmeConfig.manager')}
          label={t('qmeConfig.manager')}
          className="w-64"
          value={managerId ?? ''}
          onChange={(id) => setManagerId(id || null)}
          options={(managers ?? []).map((item) => ({
            id: item.id,
            label: item.id,
            hint: item.running ? undefined : t('qmeConfig.stopped'),
          }))}
        />
        <Button size="sm" variant="ghost" title={t('action.refresh')} aria-label={t('action.refresh')} disabled={loading || !managerId} onClick={() => void load()}>
          <ButtonGlyph busy={loading}><ArrowsClockwise size={13} weight="bold" /></ButtonGlyph>
        </Button>
        <Segmented<QmeConfigKind | 'all'>
          ariaLabel={t('qmeConfig.kind')}
          value={kind}
          onChange={setKind}
          options={[
            { id: 'all', label: t('filter.all') },
            ...KINDS.map((item) => ({
              id: item,
              label: `${t(KIND_LABEL[item])} · ${onlyLoose ? counted[item].loose : counted[item].total}`,
            })),
          ]}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput className="min-w-64 flex-1" value={query} placeholder={t('qmeConfig.search')} onChange={setQuery} />
        <Toggle checked={onlyLoose} onChange={setOnlyLoose} label={t('qmeConfig.onlyLoose')} />
        <Toggle checked={showSystem} onChange={setShowSystem} label={t('qmeConfig.showSystem')} title={t('qmeConfig.showSystem.hint')} />
      </div>

      <ErrorBar error={error} />
      {managers && managers.length === 0 && <Notice tone="warn">{t('qmeConfig.noManagers')}</Notice>}
      {audit && audit.failures.length > 0 && (
        <Notice tone="warn">{t('qmeConfig.partly', { list: audit.failures.join('; ') })}</Notice>
      )}
      {outcomes && (
        <Notice
          tone={outcomes.some((item) => item.error) ? 'warn' : 'ok'}
          onClose={() => setOutcomes(null)}
          closeLabel={t('action.close')}
        >
          {outcomes.some((item) => item.error) ? (
            <>
              {t('qmeConfig.saved.partly', { failed: outcomes.filter((item) => item.error).length, total: outcomes.length })}
              <ul className="mt-1 list-disc pl-5">
                {outcomes.filter((item) => item.error).map((item) => (
                  <li key={key(item)}>{t(KIND_LABEL[item.kind])} {item.id}: {errorText(item.error)}</li>
                ))}
              </ul>
            </>
          ) : t('qmeConfig.saved', { count: outcomes.length })}
        </Notice>
      )}

      <Panel className="flex-1">
        <DataTable>
          <colgroup>
            <col className="w-10" />
            <col className="w-44" />
            <col />
            <col className="w-28" />
            <col className="w-40" />
          </colgroup>
          <THead>
            <Th>
              <Checkbox
                aria-label={t('qmeConfig.selectAll')}
                checked={allChosen}
                disabled={selectable.length === 0}
                onChange={() => setSelected((prev) => {
                  const next = new Set(prev)
                  for (const item of selectable) {
                    if (allChosen) next.delete(key(item))
                    else next.add(key(item))
                  }
                  return next
                })}
              />
            </Th>
            <Th>{t('qmeConfig.kind')}</Th>
            <Th>{t('qmeConfig.object')}</Th>
            <Th align="right">{t('qmeConfig.messages')}</Th>
            <Th>{t('qmeConfig.state')}</Th>
          </THead>
          <tbody>
            {visible.map((item) => {
              const chosen = selected.has(key(item))
              const addressLoose = item.kind === 'queue' && !!item.address && !storedAddresses.has(item.address)
              return (
                <tr
                  key={key(item)}
                  onClick={() => !item.stored && toggle(item)}
                  className={cx(
                    'border-b border-line/60 transition',
                    !item.stored && 'cursor-pointer',
                    chosen ? 'bg-accent/8' : !item.stored && 'hover:bg-surface-2',
                  )}
                >
                  <td className="px-3 py-1.5">
                    <Checkbox
                      checked={chosen}
                      disabled={item.stored}
                      aria-label={item.id}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => toggle(item)}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-content-muted">{t(KIND_LABEL[item.kind])}</td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 truncate font-mono text-[12px]" title={item.id}>{item.id}</span>
                      {item.autoCreated && <Badge title={t('qmeConfig.autoCreated.hint')}>{t('qmeConfig.autoCreated')}</Badge>}
                      {item.system && <Badge>{t('qmeConfig.system')}</Badge>}
                    </div>
                    <div className="truncate text-[11px] text-content-subtle" title={item.detail ?? undefined}>
                      {item.kind === 'queue' && item.address && item.address !== item.id ? `${item.address} · ` : ''}
                      {item.detail}
                      {addressLoose && !item.stored && (
                        <span className="text-caution" title={t('qmeConfig.addressLoose.hint')}> · {t('qmeConfig.addressLoose')}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-content-muted">
                    {item.messages ?? '—'}
                  </td>
                  <td className="px-3 py-1.5">
                    {item.stored
                      ? <Badge tone="ok">{t('qmeConfig.stored')}</Badge>
                      : <Badge tone="warn">{t('qmeConfig.notStored')}</Badge>}
                  </td>
                </tr>
              )
            })}
            {visible.length === 0 && (
              <TableMessage colSpan={5} busy={loading}>
                {loading ? t('empty.scanning') : onlyLoose && audit ? t('qmeConfig.allStored') : t('table.empty')}
              </TableMessage>
            )}
          </tbody>
        </DataTable>
      </Panel>

      <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-5 py-3">
        <span className="text-[11.5px] text-content-subtle">{t('qmeConfig.shown', { visible: visible.length, total })}</span>
        {selected.size > 0 && (
          <>
            <Badge tone="accent">{t('api.domains.selected', { count: selected.size })}</Badge>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>{t('action.deselect')}</Button>
          </>
        )}
        <Button
          variant="primary"
          className="ml-auto min-w-52"
          disabled={plan.chosen.length === 0}
          onClick={() => setConfirming(true)}
        >
          <FloppyDisk size={14} weight="bold" />
          {t('qmeConfig.store', { count: plan.chosen.length + plan.added.length })}
        </Button>
      </div>

      <Modal
        open={confirming}
        onClose={() => !saving && setConfirming(false)}
        closeLabel={t('action.close')}
        title={t('qmeConfig.confirm.title', { manager: managerId ?? '' })}
        width="roomy"
        footer={(
          <>
            <Button variant="ghost" disabled={saving} onClick={() => setConfirming(false)}>{t('action.cancel')}</Button>
            <Button
              variant={environment === 'prod' ? 'danger' : 'primary'}
              className="min-w-40"
              disabled={saving || missingPassword}
              title={missingPassword ? t('qmeConfig.confirm.needPasswords') : undefined}
              onClick={() => void save()}
            >
              <ButtonGlyph busy={saving}><FloppyDisk size={14} weight="bold" /></ButtonGlyph>
              {t('qmeConfig.confirm.run')}
            </Button>
          </>
        )}
      >
        <div className="space-y-3 text-[13px] leading-relaxed">
          <p className="text-content-muted">{t('qmeConfig.confirm.text')}</p>
          {environment === 'prod' && <Notice tone="warn">{t('qmeConfig.confirm.prod')}</Notice>}
          {plan.added.length > 0 && (
            <Notice tone="warn">
              {t('qmeConfig.confirm.addresses', { list: plan.added.map((item) => item.id).join(', ') })}
            </Notice>
          )}
          <div className="max-h-56 overflow-y-auto rounded-lg border border-line">
            {[...plan.added, ...plan.chosen].map((item) => (
              <div key={key(item)} className="flex items-center gap-2 border-b border-line/60 px-3 py-1.5 last:border-b-0">
                <span className="w-40 shrink-0 text-[11.5px] text-content-subtle">{t(KIND_LABEL[item.kind])}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{item.id}</span>
              </div>
            ))}
          </div>
          {users.length > 0 && (
            <div className="space-y-2">
              <p className="text-[12px] text-content-muted">{t('qmeConfig.confirm.passwords')}</p>
              {users.map((item) => (
                <label key={item.id} className="flex items-center gap-3">
                  <span className="w-40 shrink-0 truncate font-mono text-[12px]">{item.id}</span>
                  <TextInput
                    type="password"
                    autoComplete="new-password"
                    value={passwords[item.id] ?? ''}
                    placeholder={t('qmeConfig.confirm.password')}
                    onChange={(event) => setPasswords((prev) => ({ ...prev, [item.id]: event.target.value }))}
                  />
                </label>
              ))}
            </div>
          )}
          {saving && (
            <div className="flex items-center gap-2 text-content-muted"><Spinner className="size-4" /> {t('qmeConfig.confirm.saving')}</div>
          )}
        </div>
      </Modal>
    </ScreenBody>
  )
}
