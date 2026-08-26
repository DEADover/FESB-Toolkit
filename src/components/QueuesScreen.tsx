import { useCallback, useEffect, useMemo, useState } from 'react'

import { useI18n } from '../i18n'
import { apiQueueManagers, apiQueues, errorText } from '../lib/api'
import type { Connection, QueueManager, QueueRow, ServerInfo } from '../types'
import { ErrorBar, NotConnected, Panel, TableMessage, useApiData } from './ApiShell'
import { Badge, Button, Checkbox, Spinner, TextInput, cx } from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  onGoToConnection: () => void
}

/**
 * Менеджеры очередей и их очереди.
 *
 * Главная польза для нашей задачи — проверить, что брокер и очередь, на которые
 * переводится трассировка, действительно существуют: значение `broker` в
 * `domain.xml` пишется ровно так же, как показано здесь.
 */
export function QueuesScreen({ connection, server, onGoToConnection }: Props) {
  const { t } = useI18n()
  const load = useCallback((connection: Connection) => apiQueueManagers(connection), [])
  const managers = useApiData<QueueManager[]>(connection, load)

  const [selected, setSelected] = useState<QueueManager | null>(null)
  const [queues, setQueues] = useState<QueueRow[] | null>(null)
  const [loadingQueues, setLoadingQueues] = useState(false)
  const [queueError, setQueueError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [hideInternal, setHideInternal] = useState(true)
  const [copied, setCopied] = useState<string | null>(null)

  // По умолчанию открываем работающий менеджер: у остановленного очередей нет.
  useEffect(() => {
    const list = managers.data
    if (!list || list.length === 0) {
      setSelected(null)
      return
    }
    setSelected((prev) => {
      if (prev && list.some((item) => item.broker === prev.broker)) return prev
      return list.find((item) => item.running) ?? list[0]
    })
  }, [managers.data])

  const openQueues = useCallback(async (manager: QueueManager | null) => {
    if (!connection || !manager) {
      setQueues(null)
      return
    }
    setLoadingQueues(true)
    setQueueError(null)
    try {
      setQueues(await apiQueues(connection, manager.kind, manager.id))
    } catch (err) {
      setQueueError(errorText(err))
      setQueues(null)
    } finally {
      setLoadingQueues(false)
    }
  }, [connection])

  useEffect(() => { void openQueues(selected) }, [openQueues, selected])

  const visible = useMemo(() => {
    if (!queues) return []
    const needle = query.trim().toLowerCase()
    return queues.filter((queue) => {
      if (hideInternal && queue.internal) return false
      if (!needle) return true
      return queue.name.toLowerCase().includes(needle) || (queue.address ?? '').toLowerCase().includes(needle)
    })
  }, [queues, query, hideInternal])

  const copy = useCallback((value: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(value)
      setTimeout(() => setCopied((prev) => (prev === value ? null : prev)), 1500)
    }).catch(() => {})
  }, [])

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  const list = managers.data ?? []

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-4">
      <ErrorBar error={managers.error} />

      <div className="flex min-h-0 flex-1 gap-3">
        <Panel className="w-72 shrink-0">
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface-2 px-3 py-2">
            <span className="text-[11px] tracking-wide text-content-subtle">{t('queues.managers')}</span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => void managers.reload()}
              disabled={managers.loading}
            >
              {managers.loading ? <Spinner className="size-3.5" /> : '↻'}
            </Button>
          </div>
          <div className="flex flex-col p-1.5">
            {list.map((manager) => (
              <button
                key={manager.broker}
                type="button"
                onClick={() => setSelected(manager)}
                className={cx(
                  'flex items-center gap-2 rounded-lg px-2.5 py-2 text-left transition',
                  selected?.broker === manager.broker ? 'bg-accent/12' : 'hover:bg-surface-3',
                )}
              >
                <span className={cx('size-1.5 shrink-0 rounded-full', manager.running ? 'bg-positive' : 'bg-content-subtle/50')} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12px]">{manager.broker}</span>
                  <span className="block truncate text-[10.5px] text-content-subtle">
                    {manager.status}{manager.autoStart ? ` · ${t('queues.autoStart')}` : ''}
                  </span>
                </span>
              </button>
            ))}
            {list.length === 0 && (
              <p className="px-2.5 py-6 text-center text-[11.5px] text-content-subtle">
                {managers.loading ? t('empty.scanning') : t('queues.noManagers')}
              </p>
            )}
          </div>
        </Panel>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <TextInput
                value={query}
                placeholder={t('queues.search')}
                className="pl-8"
                onChange={(event) => setQuery(event.target.value)}
              />
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle">⌕</span>
            </div>
            <label className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 text-[12.5px] text-content-muted">
              <Checkbox checked={hideInternal} onChange={(event) => setHideInternal(event.target.checked)} />
              {t('queues.hideInternal')}
            </label>
            {selected && (
              <Button
                onClick={() => copy(selected.broker)}
                title={t('queues.copyHint')}
              >
                {copied === selected.broker ? t('queues.copied') : t('queues.copyBroker')}
              </Button>
            )}
            <Button onClick={() => void openQueues(selected)} disabled={loadingQueues || !selected}>
              {loadingQueues ? <Spinner className="size-4" /> : '↻'} {t('action.refresh')}
            </Button>
          </div>

          <ErrorBar error={queueError} />

          {selected && !selected.running && (
            <p className="rounded-lg border border-caution/35 bg-caution/10 px-3 py-2 text-[11.5px] text-caution">
              {t('queues.stoppedHint', { broker: selected.broker })}
            </p>
          )}

          <Panel className="flex-1">
            <table className="w-full table-fixed border-collapse text-[12.5px]">
              <colgroup>
                <col />
                <col className="w-24" />
                <col className="w-24" />
                <col className="w-28" />
                <col className="w-28" />
                <col className="w-28" />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-surface-2 text-[11px] tracking-wide text-content-subtle">
                <tr className="border-b border-line">
                  <th className="px-3 py-2 text-left font-medium">{t('queues.queue')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('queues.messages')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('queues.consumers')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('queues.enqueued')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('queues.dequeued')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('table.state')}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((queue) => (
                  <tr key={`${queue.address ?? ''}/${queue.name}`} className="border-b border-line/60 hover:bg-surface-2">
                    <td className="px-3 py-1.5">
                      <div className="truncate font-mono text-[12px]" title={queue.name}>{queue.name}</div>
                      {queue.address && queue.address !== queue.name && (
                        <div className="truncate text-[10.5px] text-content-subtle" title={queue.address}>{queue.address}</div>
                      )}
                    </td>
                    <td className={cx('px-3 py-1.5 text-right tabular-nums', queue.messages > 0 && 'font-medium text-accent-content')}>
                      {queue.messages}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{queue.consumers}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-content-subtle">{queue.enqueued ?? '—'}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-content-subtle">{queue.dequeued ?? '—'}</td>
                    <td className="px-3 py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {queue.paused && <Badge tone="warn">{t('queues.paused')}</Badge>}
                        {queue.internal && <Badge>{t('queues.internal')}</Badge>}
                        {queue.durable && <Badge tone="accent">{t('queues.durable')}</Badge>}
                      </div>
                    </td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <TableMessage colSpan={6}>
                    {loadingQueues ? t('empty.scanning') : t('queues.empty')}
                  </TableMessage>
                )}
              </tbody>
            </table>
          </Panel>
        </div>
      </div>
    </div>
  )
}
