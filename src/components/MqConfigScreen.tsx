import { useCallback, useEffect, useMemo, useState } from 'react'

import { ArrowsClockwise, FileXls, FloppyDisk, MinusCircle } from '@phosphor-icons/react'

import { useI18n, type MessageKey } from '../i18n'
import { apiMqConfig, apiMqStore, apiQueueManagers, errorText, revealPath, saveReport, saveXlsxAs } from '../lib/api'
import { localStamp } from '../lib/paths'
import type { Environment } from '../lib/connection'
import type { Connection, MqConfigAudit, MqConfigItem, MqConfigKind, MqStoreOutcome, QueueManager, ServerInfo } from '../types'
import { ErrorBar, NotConnected, Panel, ScreenBody, StatsBar, TableMessage } from './ApiShell'
import { useToast } from './Toaster'
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

/** Порядок разделов — как в меню менеджера в веб-интерфейсе FESB. */
const KINDS_BY_MANAGER: Record<'QME' | 'QMS', MqConfigKind[]> = {
  QME: ['queue', 'address', 'divert', 'addressSetting', 'security', 'user'],
  QMS: ['queue', 'topic'],
}

const KIND_LABEL: Record<MqConfigKind, MessageKey> = {
  queue: 'mqConfig.kind.queue',
  topic: 'mqConfig.kind.topic',
  address: 'mqConfig.kind.address',
  divert: 'mqConfig.kind.divert',
  addressSetting: 'mqConfig.kind.addressSetting',
  security: 'mqConfig.kind.security',
  user: 'mqConfig.kind.user',
}

const key = (item: { kind: MqConfigKind; id: string }) => `${item.kind}\u0000${item.id}`

/**
 * Какие объекты менеджеров очередей хранятся в конфигурации.
 *
 * Объект без галочки «Хранить в конфигурации» живёт только в хранилище
 * брокера и не переедет вместе с конфигурацией на другой стенд. Экран
 * собирает такие объекты менеджера в одну таблицу — у РМО из шести разделов,
 * у мультименеджера это очереди и топики, — чтобы пройти по ним и решить,
 * что сохранять.
 *
 * Для РМО сохранение учитывает две вещи, проверенные на стенде: очередь
 * записывается, только если записан её адрес, — поэтому адрес добавляется
 * сам; а пароль пользователя шина не отдаёт — поэтому его вводят заново.
 */
export function MqConfigScreen({ connection, server, environment, onGoToConnection }: Props) {
  const { t } = useI18n()
  const [managers, setManagers] = useState<QueueManager[] | null>(null)
  /** Менеджер в том виде, как он пишется в шине: `QME:EQM`, `QMS:QM`. */
  const [managerKey, setManagerKey] = useState<string | null>(null)
  const [audit, setAudit] = useState<MqConfigAudit | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<MqConfigKind | 'all'>('all')
  const [onlyLoose, setOnlyLoose] = useState(true)
  const [showSystem, setShowSystem] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** Что подтверждают: поставить галочку или снять. */
  const [confirming, setConfirming] = useState<'store' | 'release' | null>(null)
  const [passwords, setPasswords] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [outcomes, setOutcomes] = useState<MqStoreOutcome[] | null>(null)

  const toast = useToast()
  const [exporting, setExporting] = useState(false)

  // Удалённые менеджеры (RQMS) своей конфигурации здесь не держат — их нет в списке.
  useEffect(() => {
    if (!connection || !server) return
    let alive = true
    apiQueueManagers(connection)
      .then((list) => {
        if (!alive) return
        const local = list.filter((item) => item.kind === 'QME' || item.kind === 'QMS')
        setManagers(local)
        setManagerKey((current) => current ?? local.find((item) => item.running)?.broker ?? local[0]?.broker ?? null)
      })
      .catch((err) => alive && setError(errorText(err)))
    return () => { alive = false }
  }, [connection, server])

  const manager = managers?.find((item) => item.broker === managerKey) ?? null
  const managerId = manager?.id ?? null
  const KINDS = KINDS_BY_MANAGER[manager?.kind === 'QMS' ? 'QMS' : 'QME']

  const load = useCallback(async () => {
    if (!connection || !manager) return
    setLoading(true)
    setError(null)
    try {
      setAudit(await apiMqConfig(connection, manager.kind, manager.id))
    } catch (err) {
      setError(errorText(err))
      setAudit(null)
    } finally {
      setLoading(false)
    }
  }, [connection, manager])

  useEffect(() => {
    setSelected(new Set())
    setKind('all')
    setOutcomes(null)
    void load()
  }, [load])

  // Ответ по прежнему менеджеру, пока грузится новый, не показываем: у РМО и
  // мультименеджера разные разделы, и чужие объекты не легли бы ни в один.
  const current = audit && manager && audit.manager === manager.kind && audit.server === manager.id ? audit : null
  const items = useMemo(() => current?.items ?? [], [current])
  const byKey = useMemo(() => new Map(items.map((item) => [key(item), item])), [items])
  const storedAddresses = useMemo(
    () => new Set(items.filter((item) => item.kind === 'address' && item.stored).map((item) => item.id)),
    [items],
  )

  const counted = useMemo(() => {
    const all: MqConfigKind[] = ['address', 'queue', 'topic', 'divert', 'addressSetting', 'security', 'user']
    const count = Object.fromEntries(all.map((item) => [item, { total: 0, loose: 0 }])) as Record<MqConfigKind, { total: number; loose: number }>
    for (const item of items) {
      if (item.system && !showSystem) continue
      if (!count[item.kind]) continue
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
  }, [items, showSystem, kind, onlyLoose, query, KINDS])

  // Галочку можно менять в обе стороны; только у составных очередей QMS её нет.
  const selectable = visible.filter((item) => !item.fixed)
  const allChosen = selectable.length > 0 && selectable.every((item) => selected.has(key(item)))

  /**
   * Что уйдёт на запись в каждую сторону.
   *
   * Сохраняя очередь, нужно сохранить и её адрес: без него очередь в файл
   * не запишется. Убирая адрес, шина сама убирает и его очереди — они
   * добавляются в список заранее, чтобы это не случилось молча.
   */
  const plans = useMemo(() => {
    const chosen = [...selected].map((id) => byKey.get(id)).filter((item): item is MqConfigItem => !!item && !item.fixed)

    const toStore = chosen.filter((item) => !item.stored)
    const storeKeys = new Set(toStore.map(key))
    const storeAdded: MqConfigItem[] = []
    for (const item of toStore) {
      if (item.kind !== 'queue' || !item.address || storedAddresses.has(item.address)) continue
      const address = byKey.get(key({ kind: 'address', id: item.address }))
      if (address && !storeKeys.has(key(address))) {
        storeKeys.add(key(address))
        storeAdded.push(address)
      }
    }

    const toRelease = chosen.filter((item) => item.stored)
    const releaseKeys = new Set(toRelease.map(key))
    const released = new Set(toRelease.filter((item) => item.kind === 'address').map((item) => item.id))
    const releaseAdded = items.filter((item) => item.kind === 'queue' && item.stored && item.address
      && released.has(item.address) && !releaseKeys.has(key(item)))

    return {
      store: { chosen: toStore, added: storeAdded },
      release: { chosen: toRelease, added: releaseAdded },
    }
  }, [selected, byKey, storedAddresses, items])

  const plan = plans[confirming ?? 'store']
  // Пароль нужен только для сохранения: убирая пользователя, пароль шина не трогает.
  const users = confirming === 'store' ? plan.chosen.filter((item) => item.kind === 'user') : []
  const missingPassword = users.some((item) => !passwords[item.id])

  const toggle = (item: MqConfigItem) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(key(item))) next.delete(key(item))
    else next.add(key(item))
    return next
  })

  const save = useCallback(async () => {
    if (!connection || !manager) return
    setSaving(true)
    try {
      const stored = confirming !== 'release'
      const requests = [...plan.added, ...plan.chosen].map((item) => ({
        kind: item.kind,
        id: item.id,
        stored,
        password: stored && item.kind === 'user' ? passwords[item.id] ?? null : null,
      }))
      setOutcomes(await apiMqStore(connection, manager.kind, manager.id, requests))
      setConfirming(null)
      setSelected(new Set())
      setPasswords({})
      await load()
    } catch (err) {
      setError(errorText(err))
      setConfirming(null)
    } finally {
      setSaving(false)
    }
  }, [connection, manager, plan, confirming, passwords, load])

  /** В файл уходит то, что видно на экране: фильтры — часть отчёта. */
  const exportXlsx = useCallback(async () => {
    if (!manager) return
    const headers = [
      t('mqConfig.manager'), t('mqConfig.kind'), t('mqConfig.object'), t('mqConfig.detail'),
      t('mqConfig.messages'), t('mqConfig.state'),
    ]
    const body = visible.map((item) => [
      manager.broker,
      t(KIND_LABEL[item.kind]),
      item.id,
      [
        item.kind === 'queue' && item.address && item.address !== item.id ? item.address : null,
        item.detail,
        item.autoCreated ? t('mqConfig.autoCreated') : null,
        item.system ? t('mqConfig.system') : null,
      ].filter(Boolean).join(' · '),
      item.messages === null ? '' : String(item.messages),
      item.fixed ? t('mqConfig.fixed') : item.stored ? t('mqConfig.stored') : t('mqConfig.notStored'),
    ])
    const output = await saveXlsxAs(t('mqConfig.save'), `fesb-mq-config-${manager.id}-${localStamp()}.xlsx`)
    if (!output) return
    setExporting(true)
    try {
      await saveReport(output, manager.id, headers, body)
      toast({
        tone: 'ok',
        title: t('report.saved'),
        text: `${output.split(/[/\\]/).pop()} · ${t('report.savedRows', { count: body.length })}`,
        action: { label: t('action.reveal'), onClick: () => void revealPath(output) },
      })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setExporting(false)
    }
  }, [manager, visible, t, toast])

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  const loose = items.filter((item) => !item.stored && (showSystem || !item.system)).length
  const total = items.filter((item) => showSystem || !item.system).length

  return (
    <ScreenBody>
      <StatsBar>
        {current ? (
          <>
            <Readout label={t('mqConfig.total')} value={String(total)} />
            <Readout label={t('mqConfig.loose')} value={String(loose)} tone={loose > 0 ? 'warn' : undefined} hint={t('mqConfig.loose.hint')} />
            <span className="text-[12px] text-content-muted">{t('mqConfig.intro')}</span>
          </>
        ) : (
          <span className="text-[12px] text-content-muted">{t('mqConfig.intro')}</span>
        )}
      </StatsBar>

      <div className="flex flex-wrap items-center gap-2">
        <Select<string>
          ariaLabel={t('mqConfig.manager')}
          label={t('mqConfig.manager')}
          className="w-72"
          value={managerKey ?? ''}
          onChange={(id) => setManagerKey(id || null)}
          options={(managers ?? []).map((item) => ({
            id: item.broker,
            label: item.broker,
            hint: item.running ? t(item.kind === 'QMS' ? 'mqConfig.qms' : 'mqConfig.qme') : t('mqConfig.stopped'),
          }))}
        />
        <Button size="sm" variant="ghost" title={t('action.refresh')} aria-label={t('action.refresh')} disabled={loading || !manager} onClick={() => void load()}>
          <ButtonGlyph busy={loading}><ArrowsClockwise size={13} weight="bold" /></ButtonGlyph>
        </Button>
        <Segmented<MqConfigKind | 'all'>
          ariaLabel={t('mqConfig.kind')}
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
        <SearchInput className="min-w-64 flex-1" value={query} placeholder={t('mqConfig.search')} onChange={setQuery} />
        <Toggle checked={onlyLoose} onChange={setOnlyLoose} label={t('mqConfig.onlyLoose')} />
        <Toggle checked={showSystem} onChange={setShowSystem} label={t('mqConfig.showSystem')} title={t('mqConfig.showSystem.hint')} />
      </div>

      <ErrorBar error={error} />
      {managers && managers.length === 0 && <Notice tone="warn">{t('mqConfig.noManagers')}</Notice>}
      {current && current.failures.length > 0 && (
        <Notice tone="warn">{t('mqConfig.partly', { list: current.failures.join('; ') })}</Notice>
      )}
      {outcomes && (
        <Notice
          tone={outcomes.some((item) => item.error) ? 'warn' : 'ok'}
          onClose={() => setOutcomes(null)}
          closeLabel={t('action.close')}
        >
          {outcomes.some((item) => item.error) ? (
            <>
              {t('mqConfig.saved.partly', { failed: outcomes.filter((item) => item.error).length, total: outcomes.length })}
              <ul className="mt-1 list-disc pl-5">
                {outcomes.filter((item) => item.error).map((item) => (
                  <li key={key(item)}>{t(KIND_LABEL[item.kind])} {item.id}: {errorText(item.error)}</li>
                ))}
              </ul>
            </>
          ) : t('mqConfig.saved', { count: outcomes.length })}
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
                aria-label={t('mqConfig.selectAll')}
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
            <Th>{t('mqConfig.kind')}</Th>
            <Th>{t('mqConfig.object')}</Th>
            <Th align="right">{t('mqConfig.messages')}</Th>
            <Th>{t('mqConfig.state')}</Th>
          </THead>
          <tbody>
            {visible.map((item) => {
              const chosen = selected.has(key(item))
              const addressLoose = item.kind === 'queue' && !!item.address && !storedAddresses.has(item.address)
              return (
                <tr
                  key={key(item)}
                  onClick={() => !item.fixed && toggle(item)}
                  className={cx(
                    'border-b border-line/60 transition',
                    !item.fixed && 'cursor-pointer',
                    chosen ? 'bg-accent/8' : !item.fixed && 'hover:bg-surface-2',
                  )}
                >
                  <td className="px-3 py-1.5">
                    <Checkbox
                      checked={chosen}
                      disabled={item.fixed}
                      aria-label={item.id}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => toggle(item)}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-content-muted">{t(KIND_LABEL[item.kind])}</td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 truncate font-mono text-[12px]" title={item.id}>{item.id}</span>
                      {item.autoCreated && <Badge title={t('mqConfig.autoCreated.hint')}>{t('mqConfig.autoCreated')}</Badge>}
                      {item.system && <Badge>{t('mqConfig.system')}</Badge>}
                    </div>
                    <div className="truncate text-[11px] text-content-subtle" title={item.detail ?? undefined}>
                      {item.kind === 'queue' && item.address && item.address !== item.id ? `${item.address} · ` : ''}
                      {item.detail}
                      {addressLoose && !item.stored && (
                        <span className="text-caution" title={t('mqConfig.addressLoose.hint')}> · {t('mqConfig.addressLoose')}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-content-muted">
                    {item.messages ?? '—'}
                  </td>
                  <td className="px-3 py-1.5">
                    {item.fixed
                      ? <Badge tone="ok" title={t('mqConfig.fixed.hint')}>{t('mqConfig.fixed')}</Badge>
                      : item.stored
                        ? <Badge tone="ok">{t('mqConfig.stored')}</Badge>
                        : <Badge tone="warn">{t('mqConfig.notStored')}</Badge>}
                  </td>
                </tr>
              )
            })}
            {visible.length === 0 && (
              <TableMessage colSpan={5} busy={loading}>
                {loading ? t('empty.scanning') : onlyLoose && current ? t('mqConfig.allStored') : t('table.empty')}
              </TableMessage>
            )}
          </tbody>
        </DataTable>
      </Panel>

      <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-5 py-3">
        <span className="text-[11.5px] text-content-subtle">{t('mqConfig.shown', { visible: visible.length, total })}</span>
        {selected.size > 0 && (
          <>
            <Badge tone="accent">{t('api.domains.selected', { count: selected.size })}</Badge>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>{t('action.deselect')}</Button>
          </>
        )}
        <Button
          className="ml-auto"
          disabled={exporting || visible.length === 0}
          onClick={() => void exportXlsx()}
        >
          <ButtonGlyph busy={exporting}><FileXls size={14} weight="bold" /></ButtonGlyph>
          {t('mqConfig.export')}
        </Button>
        {plans.release.chosen.length > 0 && (
          <Button onClick={() => setConfirming('release')}>
            <MinusCircle size={14} weight="bold" />
            {t('mqConfig.release', { count: plans.release.chosen.length + plans.release.added.length })}
          </Button>
        )}
        <Button
          variant="primary"
          className="min-w-52"
          disabled={plans.store.chosen.length === 0}
          onClick={() => setConfirming('store')}
        >
          <FloppyDisk size={14} weight="bold" />
          {t('mqConfig.store', { count: plans.store.chosen.length + plans.store.added.length })}
        </Button>
      </div>

      <Modal
        open={confirming !== null}
        onClose={() => !saving && setConfirming(null)}
        closeLabel={t('action.close')}
        title={t(confirming === 'release' ? 'mqConfig.release.title' : 'mqConfig.confirm.title', { manager: managerId ?? '' })}
        width="roomy"
        footer={(
          <>
            <Button variant="ghost" disabled={saving} onClick={() => setConfirming(null)}>{t('action.cancel')}</Button>
            <Button
              variant={environment === 'prod' ? 'danger' : 'primary'}
              className="min-w-40"
              disabled={saving || missingPassword}
              title={missingPassword ? t('mqConfig.confirm.needPasswords') : undefined}
              onClick={() => void save()}
            >
              <ButtonGlyph busy={saving}>
                {confirming === 'release' ? <MinusCircle size={14} weight="bold" /> : <FloppyDisk size={14} weight="bold" />}
              </ButtonGlyph>
              {t(confirming === 'release' ? 'mqConfig.release.run' : 'mqConfig.confirm.run')}
            </Button>
          </>
        )}
      >
        <div className="space-y-3 text-[13px] leading-relaxed">
          <p className="text-content-muted">{t(confirming === 'release' ? 'mqConfig.release.text' : 'mqConfig.confirm.text')}</p>
          {environment === 'prod' && <Notice tone="warn">{t('mqConfig.confirm.prod')}</Notice>}
          {plan.added.length > 0 && (
            <Notice tone="warn">
              {t(confirming === 'release' ? 'mqConfig.release.queues' : 'mqConfig.confirm.addresses', { list: plan.added.map((item) => item.id).join(', ') })}
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
              <p className="text-[12px] text-content-muted">{t('mqConfig.confirm.passwords')}</p>
              {users.map((item) => (
                <label key={item.id} className="flex items-center gap-3">
                  <span className="w-40 shrink-0 truncate font-mono text-[12px]">{item.id}</span>
                  <TextInput
                    type="password"
                    autoComplete="new-password"
                    value={passwords[item.id] ?? ''}
                    placeholder={t('mqConfig.confirm.password')}
                    onChange={(event) => setPasswords((prev) => ({ ...prev, [item.id]: event.target.value }))}
                  />
                </label>
              ))}
            </div>
          )}
          {saving && (
            <div className="flex items-center gap-2 text-content-muted"><Spinner className="size-4" /> {t('mqConfig.confirm.saving')}</div>
          )}
        </div>
      </Modal>
    </ScreenBody>
  )
}
