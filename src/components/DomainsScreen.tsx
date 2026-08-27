import { useCallback, useEffect, useMemo, useState } from 'react'

import { ArrowsClockwise, Play, Stop } from '@phosphor-icons/react'

import { useI18n } from '../i18n'
import { apiDomainAction, apiDomains, errorText } from '../lib/api'
import type { ApiDomain, ApiProgress, Connection, DomainAction, ServerInfo } from '../types'
import {
  NotConnected, RefreshButton, ScreenBody,
} from './ApiShell'
import { Badge, Button, Checkbox, cx, DataTable, FOCUS_RING, IconButton, Modal, Notice, SearchInput, Spinner, Th, THead, Toggle } from './ui'

/** Что делать с доменами после выгрузки. */
export type PullIntent = 'edit' | 'archive'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  pulling: boolean
  progress: ApiProgress | null
  /** Ошибка последней выгрузки — приходит из App, где живёт сам вызов. */
  error: string | null
  onPull: (guids: string[] | null, intent: PullIntent) => void
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
  /**
   * Что забираем, пока не выбрано, зачем.
   *
   * `undefined` — вопрос не задан, `null` — забираем все домены,
   * массив — выбранные. Различать нужно, потому что «все» и «пустой список»
   * для сервера не одно и то же.
   */
  const [asking, setAsking] = useState<string[] | null | undefined>(undefined)

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

  // На этом экране заглушка своя: с неё уводят прямо на подключение.
  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  const allVisibleSelected = visible.length > 0 && visible.every((domain) => selected.has(domain.guid))

  return (
    <ScreenBody>
      <div className="flex items-center gap-2">
        <SearchInput
          className="flex-1"
          value={query}
          placeholder={t('api.domains.search')}
          onChange={setQuery}
        />
        <Toggle checked={onlyActive} onChange={setOnlyActive} label={t('api.domains.onlyActive')} />
        <RefreshButton
          busy={loading}
          disabled={loading || pulling}
          onClick={() => void load()}
        />
      </div>

      {refused && (
        <Notice tone="warn">
          {t('domains.refused', { name: refused.name })}
        </Notice>
      )}

      {(listError ?? pullError) && (
        <Notice tone="danger">
          {listError ?? pullError}
        </Notice>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-surface">
        <DataTable>
          <colgroup>
            <col className="w-9" />
            <col />
            <col className="w-32" />
            <col className="w-24" />
            <col />
            <col className="w-28" />
          </colgroup>
          <THead>
              <Th className="px-2">
                <Checkbox
                  checked={allVisibleSelected}
                  onChange={toggleVisible}
                  aria-label={t('api.domains.selectAll')}
                />
              </Th>
              <Th className="px-2">{t('table.domain')}</Th>
              <Th className="px-2">{t('api.domains.group')}</Th>
              <Th className="px-2">{t('table.state')}</Th>
              <Th className="px-2">{t('table.guid')}</Th>
              <Th className="px-2">{t('modules.actions')}</Th>
            </THead>
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
                      icon={Play}
                      label={t('modules.start')}
                      busy={pending === `${domain.guid}:start`}
                      disabled={pending !== null || pulling || domain.active}
                      onClick={() => startAction(domain, 'start')}
                    />
                    <IconButton
                      icon={Stop}
                      label={t('modules.stop')}
                      busy={pending === `${domain.guid}:stop`}
                      disabled={pending !== null || pulling || !domain.active}
                      onClick={() => startAction(domain, 'stop')}
                    />
                    <IconButton
                      icon={ArrowsClockwise}
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
        </DataTable>
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
          <Button onClick={() => setAsking(null)} disabled={pulling} title={t('api.pull.allHint')}>
            {t('api.pull.all', { count: domains?.length ?? 0 })}
          </Button>
          <Button
            variant="primary"
            // Выбраны все домены — это и есть «забрать всё»: перечислять их незачем.
            onClick={() => setAsking(selected.size === domains?.length ? null : [...selected])}
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
          <Notice tone="warn">
            {t('domains.confirm.text')}
          </Notice>
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
              <Notice tone="warn">
                {t('domains.refusedMany')}
              </Notice>
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
      {/*
        Домены забирают ради двух разных вещей: чтобы поправить трассировку
        и чтобы просто снять копию конфигурации. Раньше выгрузка всегда
        открывала редактор, и второй случай приходилось доводить руками.
      */}
      <Modal
        open={asking !== undefined}
        onClose={() => setAsking(undefined)}
        closeLabel={t('action.close')}
        title={t('api.pull.intent.title')}
      >
        <p className="text-content-muted">{t('api.pull.intent.text')}</p>
        <div className="mt-4 flex flex-col gap-2">
          <IntentChoice
            title={t('api.pull.intent.edit')}
            text={t('api.pull.intent.edit.text')}
            onClick={() => { const guids = asking ?? null; setAsking(undefined); onPull(guids, 'edit') }}
          />
          <IntentChoice
            title={t('api.pull.intent.archive')}
            text={t('api.pull.intent.archive.text')}
            onClick={() => { const guids = asking ?? null; setAsking(undefined); onPull(guids, 'archive') }}
          />
        </div>
      </Modal>

    </ScreenBody>
  )
}

/** Один вариант ответа на «зачем забираем»: заголовок и строчка пояснения. */
function IntentChoice({ title, text, onClick }: { title: string; text: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'rounded-xl border border-line-strong bg-surface-2 px-4 py-3 text-left transition',
        'hover:border-accent/50 hover:bg-surface-3',
        FOCUS_RING,
      )}
    >
      <div className="text-[13px] font-semibold">{title}</div>
      <div className="mt-1 text-[11.5px] text-content-subtle">{text}</div>
    </button>
  )
}
