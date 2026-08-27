import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'

import { ArrowLeft, ArrowsClockwise, Check, Copy } from '@phosphor-icons/react'

import { useI18n } from '../i18n'
import { apiQueueManagers, apiQueueMessage, apiQueueMessages, apiQueues, errorText } from '../lib/api'
import type { Connection, QueueManager, QueueMessage, QueueRow, ServerInfo } from '../types'
import {
  AutoRefreshToggle, ErrorBar, NotConnected, Panel, RefreshButton, ScreenBody, TableMessage, useApiData, useAutoRefresh,
} from './ApiShell'
import {
  Badge, Button, ButtonGlyph, cx, DataTable, IconButton, Notice, rowClick, SearchInput, Spinner, Th, THead, Toggle,
} from './ui'

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
  /** Очередь, сообщения которой сейчас смотрят. */
  const [inbox, setInbox] = useState<QueueRow | null>(null)

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

  // Смена менеджера закрывает открытую очередь: сообщения были из другой.
  useEffect(() => { setInbox(null) }, [selected])

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
    <ScreenBody>
      <ErrorBar error={managers.error} />

      <div className="flex min-h-0 flex-1 gap-3">
        <Panel className="w-60 shrink-0 xl:w-72">
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface-2 px-3 py-2">
            <span className="text-[11px] tracking-wide text-content-subtle">{t('queues.managers')}</span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => void managers.reload()}
              disabled={managers.loading}
            >
              <ButtonGlyph busy={managers.loading}><ArrowsClockwise size={13} weight="bold" /></ButtonGlyph>
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
            <SearchInput
          className="flex-1"
          value={query}
          placeholder={t('queues.search')}
          onChange={setQuery}
        />
            <Toggle checked={hideInternal} onChange={setHideInternal} label={t('queues.hideInternal')} />
            {selected && (
              <IconButton
                size="md"
                icon={copied === selected.broker ? Check : Copy}
                label={copied === selected.broker ? t('queues.copied') : t('queues.copyBroker')}
                onClick={() => copy(selected.broker)}
              />
            )}
            <RefreshButton
          busy={loadingQueues}
          disabled={loadingQueues || !selected}
          onClick={() => void openQueues(selected)}
        />
          </div>

          <ErrorBar error={queueError} />

          {selected && !selected.running && (
            <Notice tone="warn" small>
              {t('queues.stoppedHint', { broker: selected.broker })}
            </Notice>
          )}

          {inbox && selected ? (
            <Messages
              connection={connection}
              manager={selected}
              queue={inbox}
              onBack={() => setInbox(null)}
            />
          ) : (
          <Panel className="flex-1">
            <DataTable>
              <colgroup>
                {/* Накопительные счётчики уходят на узком окне: имя очереди
                    и текущее число сообщений нужнее, чем «положено за всё время». */}
                <col />
                <col className="w-20" />
                <col className="w-24" />
                <col className="hidden w-24 xl:table-column" />
                <col className="hidden w-24 xl:table-column" />
                <col className="w-28" />
              </colgroup>
              <THead>
                  <Th>{t('queues.queue')}</Th>
                  <Th align="right">{t('queues.messages')}</Th>
                  <Th align="right">{t('queues.consumers')}</Th>
                  <Th align="right" className="hidden xl:table-cell">{t('queues.enqueued')}</Th>
                  <Th align="right" className="hidden xl:table-cell">{t('queues.dequeued')}</Th>
                  <Th>{t('table.state')}</Th>
                </THead>
              <tbody>
                {visible.map((queue) => (
                  <tr
                    key={`${queue.address ?? ''}/${queue.name}`}
                    onClick={rowClick(() => setInbox(queue))}
                    className="cursor-pointer border-b border-line/60 hover:bg-surface-2"
                  >
                    <td className="px-3 py-1.5">
                      <div className="truncate font-mono text-[12px]" title={t('queues.openMessages')}>{queue.name}</div>
                      {queue.address && queue.address !== queue.name && (
                        <div className="truncate text-[10.5px] text-content-subtle" title={queue.address}>{queue.address}</div>
                      )}
                    </td>
                    <td className={cx('px-3 py-1.5 text-right tabular-nums', queue.messages > 0 && 'font-medium text-accent-content')}>
                      {queue.messages}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{queue.consumers}</td>
                    <td className="hidden px-3 py-1.5 text-right tabular-nums text-content-subtle xl:table-cell">{queue.enqueued ?? '—'}</td>
                    <td className="hidden px-3 py-1.5 text-right tabular-nums text-content-subtle xl:table-cell">{queue.dequeued ?? '—'}</td>
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
            </DataTable>
          </Panel>
          )}
        </div>
      </div>
    </ScreenBody>
  )
}

/**
 * Сообщения очереди.
 *
 * Ради этого экрана всё и затевалось: трассировку настраивают на очередь,
 * а потом хотят увидеть, что в неё легло. Только чтение — удалять
 * и переотправлять сообщения этот инструмент не берётся.
 */
function Messages({ connection, manager, queue, onBack }: {
  connection: Connection
  manager: QueueManager
  queue: QueueRow
  onBack: () => void
}) {
  const { t } = useI18n()
  const [messages, setMessages] = useState<QueueMessage[]>([])
  const [full, setFull] = useState<Record<string, QueueMessage>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [auto, setAuto] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setMessages(await apiQueueMessages(connection, manager.kind, manager.id, queue.name, 200))
    } catch (err) {
      setError(errorText(err))
      setMessages([])
    } finally {
      setLoading(false)
    }
  }, [connection, manager, queue.name])

  useEffect(() => { void load() }, [load])
  useAutoRefresh(auto, load)

  /** Тело шина отдаёт только у отдельно запрошенного сообщения. */
  const expand = useCallback(async (message: QueueMessage) => {
    if (open === message.id) {
      setOpen(null)
      return
    }
    setOpen(message.id)
    if (full[message.id]) return
    try {
      const loaded = await apiQueueMessage(connection, manager.kind, manager.id, queue.name, message.id)
      setFull((prev) => ({ ...prev, [message.id]: loaded }))
    } catch (err) {
      setError(errorText(err))
    }
  }, [connection, manager, queue.name, open, full])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={onBack}><ArrowLeft size={14} weight="bold" /> {t('queues.backToQueues')}</Button>
        <span className="min-w-0 truncate font-mono text-[12.5px] font-semibold">{queue.name}</span>
        <span className="text-[11.5px] text-content-subtle">
          {t('queues.messagesCount', { count: messages.length })}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <AutoRefreshToggle checked={auto} onChange={setAuto} />
          <RefreshButton
          busy={loading}
          disabled={loading}
          onClick={() => void load()}
        />
        </div>
      </div>

      <ErrorBar error={error} />

      <Panel className="flex-1">
        <DataTable>
          <colgroup>
            <col className="w-44" />
            <col />
            <col className="w-28" />
            <col className="w-24" />
            <col className="w-20" />
          </colgroup>
          <THead>
              <Th>{t('logs.time')}</Th>
              <Th>{t('queues.messageId')}</Th>
              <Th>{t('queues.messageType')}</Th>
              <Th align="right">{t('zip.size')}</Th>
              <Th>{t('table.state')}</Th>
            </THead>
          <tbody>
            {messages.map((message) => {
              const loaded = full[message.id]
              const shown = open === message.id
              return (
                <Fragment key={message.id}>
                  <tr
                    onClick={() => void expand(message)}
                    className={cx('cursor-pointer align-top', shown ? 'bg-surface-2/60' : 'border-b border-line/60 hover:bg-surface-2')}
                  >
                    <td className="px-3 py-1.5 font-mono text-[11px] text-content-subtle">
                      {message.timestamp?.replace('T', ' ').slice(0, 23) ?? '—'}
                    </td>
                    <td className="truncate px-3 py-1.5 font-mono text-[11px]" title={message.id}>{message.id}</td>
                    <td className="px-3 py-1.5 text-content-muted">{message.bodyType ?? '—'}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{message.size}</td>
                    <td className="px-3 py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {message.persistent && <Badge tone="accent">{t('queues.persistent')}</Badge>}
                        {message.redelivered && <Badge tone="warn">{t('queues.redelivered')}</Badge>}
                      </div>
                    </td>
                  </tr>

                  {shown && (
                    <tr className="border-b border-line/60 bg-surface-2/60">
                      <td colSpan={5} className="px-3 pb-3">
                        {loaded ? <MessageBody message={loaded} /> : (
                          <span className="flex items-center gap-2 text-[11.5px] text-content-subtle">
                            <Spinner className="size-3.5" /> {t('empty.scanning')}
                          </span>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {messages.length === 0 && (
              <TableMessage colSpan={5}>{loading ? t('empty.scanning') : t('queues.noMessages')}</TableMessage>
            )}
          </tbody>
        </DataTable>
      </Panel>
    </div>
  )
}

function MessageBody({ message }: { message: QueueMessage }) {
  const { t } = useI18n()
  return (
    <div className="flex flex-col gap-3">
      {message.properties.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-line">
          <DataTable dense>
            <colgroup>
              <col className="w-56" />
              <col />
            </colgroup>
            <tbody>
              {message.properties.map((property) => (
                <tr key={property.name} className="border-b border-line last:border-b-0 align-top">
                  <td className="border-r border-line bg-surface-2/70 px-3 py-1.5 font-mono text-content-subtle">
                    {property.name}
                  </td>
                  <td className="break-all px-3 py-1.5 font-mono text-content-muted">{property.value}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </div>
      )}

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-content-subtle">
          {t('queues.body')}
          {message.truncated && ` · ${t('queues.truncated')}`}
        </div>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface px-3 py-2 font-mono text-[11px] leading-relaxed text-content-muted">
          {message.body ?? t('queues.noBody')}
        </pre>
      </div>
    </div>
  )
}
