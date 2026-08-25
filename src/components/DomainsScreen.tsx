import { useCallback, useEffect, useMemo, useState } from 'react'

import { useI18n } from '../i18n'
import { apiDomains, errorText } from '../lib/api'
import type { ApiDomain, ApiProgress, Connection, ServerInfo } from '../types'
import { Badge, Button, Checkbox, Spinner, TextInput, cx } from './ui'

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
            <col className="w-40" />
            <col className="w-24" />
            <col className="w-64" />
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
              </tr>
            ))}
            {visible.length === 0 && !loading && (
              <tr><td colSpan={5} className="px-3 py-10 text-center text-content-subtle">{t('table.empty')}</td></tr>
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
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          {pulling && (
            <span className="text-[11.5px] text-content-subtle">
              {progress?.phase === 'unpack'
                ? t('api.pull.unpacking', { current: progress.current, total: progress.total })
                : t('api.pull.downloading', { size: formatBytes(progress?.current ?? 0) })}
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
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}
