import { useCallback, useEffect, useMemo, useState } from 'react'

import { useI18n } from '../i18n'
import { apiDomainAction, apiDomains, errorText } from '../lib/api'
import type { ApiDomain, ApiProgress, Connection, DomainAction, ServerInfo } from '../types'
import { Badge, Button, Checkbox, IconButton, Modal, Spinner, TextInput, cx } from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  pulling: boolean
  progress: ApiProgress | null
  /** Ошибка последней выгрузки — приходит из App, где живёт сам вызов. */
  error: string | null
  onPull: (guids: string[] | null) => void
  onGoToConnection: () => void
}

/**
 * Список доменов сервера: отсюда выбирают, что забрать в редактор.
 *
 * Выгрузка всех доменов сразу занимает минуты, поэтому выбор нескольких —
 * основной путь, а «забрать все» вынесено отдельной кнопкой с предупреждением.
 */
export function DomainsScreen({ connection, server, pulling, progress, error: pullError, onPull, onGoToConnection }: Props) {
  const { t } = useI18n()
  const [domains, setDomains] = useState<ApiDomain[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [onlyActive, setOnlyActive] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ domain: ApiDomain; action: DomainAction } | null>(null)
  /** Домен, который шина отказалась запускать: причина остаётся в журнале. */
  const [refused, setRefused] = useState<ApiDomain | null>(null)
  /** Массовое действие: сколько сделано и что ответила шина по каждому домену. */
  const [bulk, setBulk] = useState<{
    action: DomainAction
    total: number
    done: number
    results: Array<{ name: string; done: boolean; error: string | null }>
    finished: boolean
  } | null>(null)
  const [confirmBulk, setConfirmBulk] = useState<DomainAction | null>(null)

  const load = useCallback(async () => {
    if (!connection) return
    setLoading(true)
    setListError(null)
    try {
      setDomains(await apiDomains(connection))
    } catch (err) {
      setListError(errorText(err))
      setDomains(null)
    } finally {
      setLoading(false)
    }
  }, [connection])

  // Список подтягивается сам, как только подключение подтверждено.
  useEffect(() => {
    if (server) void load()
    else setDomains(null)
  }, [server, load])

  const visible = useMemo(() => {
    if (!domains) return []
    const needle = query.trim().toLowerCase()
    return domains.filter((domain) => {
      if (onlyActive && !domain.active) return false
      if (!needle) return true
      return (
        domain.name.toLowerCase().includes(needle) ||
        domain.guid.toLowerCase().includes(needle) ||
        (domain.group ?? '').toLowerCase().includes(needle)
      )
    })
  }, [domains, query, onlyActive])

  const act = useCallback(async (domain: ApiDomain, action: DomainAction) => {
    if (!connection) return
    setConfirm(null)
    setRefused(null)
    setPending(`${domain.guid}:${action}`)
    setListError(null)
    try {
      const result = await apiDomainAction(connection, domain.guid, action)
      if (!result.done) setRefused(domain)
      await load()
    } catch (err) {
      setListError(errorText(err))
    } finally {
      setPending(null)
    }
  }, [connection, load])

  /** Запуск безобиден, остановка и перезапуск рвут обработку — спрашиваем. */
  const startAction = useCallback((domain: ApiDomain, action: DomainAction) => {
    if (action === 'start') void act(domain, action)
    else setConfirm({ domain, action })
  }, [act])

  /**
   * Массовое действие над выбранными доменами.
   *
   * Строго по очереди: поднять десяток доменов разом — заметная нагрузка
   * на шину, а торопиться тут некуда. Отказ одного не останавливает
   * остальных, но остаётся в сводке: шина отвечает `200` и телом `false`,
   * и такой домен легко потерять.
   */
  const runBulk = useCallback(async (action: DomainAction) => {
    if (!connection) return
    setConfirmBulk(null)
    const targets = (domains ?? []).filter((domain) => selected.has(domain.guid))
    if (targets.length === 0) return

    setBulk({ action, total: targets.length, done: 0, results: [], finished: false })
    setListError(null)

    for (const domain of targets) {
      let done = false
      let error: string | null = null
      try {
        done = (await apiDomainAction(connection, domain.guid, action)).done
      } catch (err) {
        error = errorText(err)
      }
      setBulk((prev) => prev && {
        ...prev,
        done: prev.done + 1,
        results: [...prev.results, { name: domain.name, done, error }],
      })
    }

    setBulk((prev) => prev && { ...prev, finished: true })
    await load()
  }, [connection, domains, selected, load])

  const toggle = useCallback((guid: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(guid)) next.delete(guid)
      else next.add(guid)
      return next
    })
  }, [])

  const toggleVisible = useCallback(() => {
    const keys = visible.map((domain) => domain.guid)
    setSelected((prev) => {
      const next = new Set(prev)
      const all = keys.length > 0 && keys.every((key) => next.has(key))
      for (const key of keys) {
        if (all) next.delete(key)
        else next.add(key)
      }
      return next
    })
  }, [visible])

  if (!connection || !server) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 pb-10">
        <div className="max-w-md text-center">
          <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-surface-2 text-[22px] text-accent-content">⇄</div>
          <h2 className="mt-4 text-[15px] font-semibold">{t('api.notConnected')}</h2>
          <p className="mt-2 text-content-subtle">{t('api.notConnected.text')}</p>
          <Button variant="primary" className="mt-5" onClick={onGoToConnection}>{t('nav.api.connection')}</Button>
        </div>
      </div>
    )
  }

  const allVisibleSelected = visible.length > 0 && visible.every((domain) => selected.has(domain.guid))

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-4">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <TextInput
            value={query}
            placeholder={t('api.domains.search')}
            className="pl-8"
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle">⌕</span>
        </div>
        <label className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 text-[12.5px] text-content-muted">
          <Checkbox checked={onlyActive} onChange={(event) => setOnlyActive(event.target.checked)} />
          {t('api.domains.onlyActive')}
        </label>
        <Button onClick={() => void load()} disabled={loading || pulling}>
          {loading ? <Spinner className="size-4" /> : '↻'} {t('action.refresh')}
        </Button>
      </div>

      {refused && (
        <div className="rounded-lg border border-caution/40 bg-caution/10 px-3 py-2 text-caution">
          {t('domains.refused', { name: refused.name })}
        </div>
      )}

      {(listError ?? pullError) && (
        <div className="rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-negative">
          {listError ?? pullError}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-surface">
        <table className="w-full table-fixed border-collapse text-[12.5px]">
          <colgroup>
            <col className="w-9" />
            <col />
            <col className="w-32" />
            <col className="w-24" />
            <col />
            <col className="w-28" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-surface-2 text-[11px] tracking-wide text-content-subtle">
            <tr className="border-b border-line">
              <th className="px-2 py-2">
                <Checkbox
                  checked={allVisibleSelected}
                  onChange={toggleVisible}
                  aria-label={t('api.domains.selectAll')}
                />
              </th>
              <th className="px-2 py-2 text-left font-medium">{t('table.domain')}</th>
              <th className="px-2 py-2 text-left font-medium">{t('api.domains.group')}</th>
              <th className="px-2 py-2 text-left font-medium">{t('table.state')}</th>
              <th className="px-2 py-2 text-left font-medium">{t('table.guid')}</th>
              <th className="px-2 py-2 text-left font-medium">{t('modules.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((domain) => (
              <tr
                key={domain.guid}
                onClick={() => toggle(domain.guid)}
                className={cx(
                  'cursor-pointer border-b border-line/60 transition',
                  selected.has(domain.guid) ? 'bg-accent/8' : 'hover:bg-surface-2',
                  !domain.active && 'text-content-subtle',
                )}
              >
                <td className="px-2 py-1.5">
                  <Checkbox
                    checked={selected.has(domain.guid)}
                    onChange={() => toggle(domain.guid)}
                    onClick={(event) => event.stopPropagation()}
                    aria-label={domain.name}
                  />
                </td>
                <td className="truncate px-2 py-1.5 font-medium" title={domain.name}>
                  {domain.name}
                  {domain.leader && <Badge tone="accent" className="ml-2">{t('api.domains.leader')}</Badge>}
                  {domain.clustered && <Badge className="ml-1.5">{t('api.domains.clustered')}</Badge>}
                </td>
                <td className="truncate px-2 py-1.5">{domain.group ?? '—'}</td>
                <td className="px-2 py-1.5">
                  {domain.active
                    ? <Badge tone="ok">{t('table.active')}</Badge>
                    : <Badge>{t('table.stopped')}</Badge>}
                </td>
                <td className="truncate px-2 py-1.5 font-mono text-[11px] text-content-subtle" title={domain.guid}>
                  {domain.guid}
                </td>
                <td className="px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                  <div className="flex items-center gap-1">
                    <IconButton
                      icon="▶"
                      label={t('modules.start')}
                      busy={pending === `${domain.guid}:start`}
                      disabled={pending !== null || pulling || domain.active}
                      onClick={() => startAction(domain, 'start')}
                    />
                    <IconButton
                      icon="■"
                      label={t('modules.stop')}
                      busy={pending === `${domain.guid}:stop`}
                      disabled={pending !== null || pulling || !domain.active}
                      onClick={() => startAction(domain, 'stop')}
                    />
                    <IconButton
                      icon="↻"
                      label={t('modules.restart')}
                      busy={pending === `${domain.guid}:restart`}
                      disabled={pending !== null || pulling || !domain.active}
                      onClick={() => startAction(domain, 'restart')}
                    />
                  </div>
                </td>
              </tr>
            ))}
            {visible.length === 0 && !loading && (
              <tr><td colSpan={6} className="px-3 py-10 text-center text-content-subtle">{t('table.empty')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-5 py-3">
        <span className="text-[11.5px] text-content-subtle">
          {t('api.domains.shown', { visible: visible.length, total: domains?.length ?? 0 })}
        </span>
        {selected.size > 0 && (
          <>
            <Badge tone="accent">{t('api.domains.selected', { count: selected.size })}</Badge>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>{t('action.deselect')}</Button>
            <span className="mx-1 h-5 w-px bg-line" />
            <Button size="sm" disabled={bulk !== null || pulling} onClick={() => void runBulk('start')}>
              {t('modules.start')}
            </Button>
            <Button size="sm" disabled={bulk !== null || pulling} onClick={() => setConfirmBulk('stop')}>
              {t('modules.stop')}
            </Button>
            <Button size="sm" disabled={bulk !== null || pulling} onClick={() => setConfirmBulk('restart')}>
              {t('modules.restart')}
            </Button>
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          {pulling && (
            <span className="text-[11.5px] text-content-subtle" title={t('api.pull.hint')}>
              {t('api.pull.progress', { current: progress?.current ?? 0, total: progress?.total ?? selected.size })}
            </span>
          )}
          <Button
            onClick={() => onPull(null)}
            disabled={pulling}
            title={t('api.pull.allHint')}
          >
            {t('api.pull.all', { count: domains?.length ?? 0 })}
          </Button>
          <Button
            variant="primary"
            // Выбраны все домены — это и есть «забрать всё»: перечислять их незачем.
            onClick={() => onPull(selected.size === domains?.length ? null : [...selected])}
            disabled={pulling || selected.size === 0}
          >
            {pulling
              ? <><Spinner className="size-4" /> {t('api.pull.running')}</>
              : t('api.pull.selected', { count: selected.size })}
          </Button>
        </div>
      </div>
      <Modal
        open={confirmBulk !== null}
        onClose={() => setConfirmBulk(null)}
        closeLabel={t('action.close')}
        title={confirmBulk === 'stop' ? t('domains.confirm.stopMany') : t('domains.confirm.restartMany')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmBulk(null)}>{t('action.cancel')}</Button>
            <Button variant="primary" onClick={() => confirmBulk && void runBulk(confirmBulk)}>
              {confirmBulk === 'stop' ? t('modules.stop') : t('modules.restart')}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[13px] leading-relaxed">
          <p className="text-content-muted">{t('domains.confirm.manyText', { count: selected.size })}</p>
          <p className="rounded-lg border border-caution/35 bg-caution/10 px-3 py-2 text-caution">
            {t('domains.confirm.text')}
          </p>
        </div>
      </Modal>

      <Modal
        open={bulk !== null}
        onClose={() => bulk?.finished && setBulk(null)}
        closeLabel={t('action.close')}
        title={t('domains.bulk.title')}
        footer={
          <Button variant="primary" disabled={!bulk?.finished} onClick={() => setBulk(null)}>
            {t('action.close')}
          </Button>
        }
      >
        {bulk && (
          <div className="space-y-3 text-[13px] leading-relaxed">
            <div className="flex items-center gap-2">
              {!bulk.finished && <Spinner className="size-4" />}
              <span>{t('domains.bulk.progress', { done: bulk.done, total: bulk.total })}</span>
            </div>
            <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
              {bulk.results.map((item, index) => (
                <div
                  key={`${item.name}-${index}`}
                  className="flex items-center gap-2 border-b border-line/60 px-3 py-1.5 last:border-b-0"
                >
                  <span className={cx(
                    'size-1.5 shrink-0 rounded-full',
                    item.error ? 'bg-negative' : item.done ? 'bg-positive' : 'bg-caution',
                  )} />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  <span className="shrink-0 text-[11px] text-content-subtle">
                    {item.error ?? (item.done ? t('domains.bulk.ok') : t('domains.bulk.refused'))}
                  </span>
                </div>
              ))}
            </div>
            {bulk.finished && bulk.results.some((item) => !item.done) && (
              <p className="rounded-lg border border-caution/35 bg-caution/10 px-3 py-2 text-caution">
                {t('domains.refusedMany')}
              </p>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        closeLabel={t('action.close')}
        title={confirm?.action === 'stop' ? t('domains.confirm.stop') : t('domains.confirm.restart')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>{t('action.cancel')}</Button>
            <Button variant="primary" onClick={() => confirm && void act(confirm.domain, confirm.action)}>
              {confirm?.action === 'stop' ? t('modules.stop') : t('modules.restart')}
            </Button>
          </>
        }
      >
        {confirm && (
          <div className="space-y-3 text-[13px] leading-relaxed">
            <code className="block break-all rounded bg-accent/12 px-2 py-1 font-mono text-accent-content">
              {confirm.domain.name}
            </code>
            <p className="text-content-muted">{t('domains.confirm.text')}</p>
          </div>
        )}
      </Modal>
    </div>
  )
}

