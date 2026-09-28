import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ArrowBendUpLeft, ArrowLeft, ArrowRight, ArrowsClockwise, Check, Copy, MagnifyingGlass, Trash } from '@phosphor-icons/react'

import { useI18n, type MessageKey } from '../i18n'
import { apiQueueManagers, apiQueueMessage, apiQueueMessages, apiQueues, apiQueueSearch, errorText, onApiProgress } from '../lib/api'
import type { Environment } from '../lib/connection'
import { cameFromElsewhere, isErrorQueue, retryBlock, type RetryBlock } from '../lib/deadLetters'
import type { ApiProgress, Connection, ManagerKind, QueueManager, QueueMessage, QueueRow, ServerInfo } from '../types'
import {
  AutoRefreshToggle, Awaiting, ErrorBar, NotConnected, Panel, RefreshButton, ScreenBody, ScreenBodyRow, TableMessage, useApiData, useAutoRefresh, useDebounced,
} from './ApiShell'
import { MessageActionDialog, type ActionKind } from './MessageActionDialog'
import {
  Badge, Button, ButtonGlyph, Checkbox, cx, DataTable, Highlight, IconButton, Notice, rowClick, SearchInput, Spinner, Th, THead, Toggle,
} from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  onGoToConnection: () => void
  /** Менеджер, который открыть сразу, — когда пришли из палитры. */
  initialManager?: { kind: ManagerKind; id: string } | null
  initialQuery?: string
  /** Среда стенда — на продуктиве действия с сообщениями предупреждают отдельно. */
  environment?: Environment | null
}

/**
 * Менеджеры очередей и их очереди.
 *
 * Главная польза для нашей задачи — проверить, что брокер и очередь, на которые
 * переводится трассировка, действительно существуют: значение `broker` в
 * `domain.xml` пишется ровно так же, как показано здесь.
 */
export function QueuesScreen({ connection, server, onGoToConnection, initialManager = null, initialQuery = '', environment = null }: Props) {
  const { t } = useI18n()
  const load = useCallback((connection: Connection) => apiQueueManagers(connection), [])
  const managers = useApiData<QueueManager[]>(connection, load)

  const [selected, setSelected] = useState<QueueManager | null>(null)
  const [queues, setQueues] = useState<QueueRow[] | null>(null)
  const [loadingQueues, setLoadingQueues] = useState(false)
  const [queueError, setQueueError] = useState<string | null>(null)
  const [query, setQuery] = useState(initialQuery)
  const [hideInternal, setHideInternal] = useState(true)
  const [onlyErrors, setOnlyErrors] = useState(false)
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
      const wanted = initialManager && list.find((item) => item.kind === initialManager.kind && item.id === initialManager.id)
      return wanted || (list.find((item) => item.running) ?? list[0])
    })
  }, [managers.data, initialManager])

  // Номер последнего открытия: очереди медленного менеджера не должны
  // лечь под заголовок того, что выбрали после него.
  const opening = useRef(0)

  const openQueues = useCallback(async (manager: QueueManager | null) => {
    const ticket = ++opening.current
    if (!connection || !manager) {
      setQueues(null)
      return
    }
    setLoadingQueues(true)
    setQueueError(null)
    try {
      const rows = await apiQueues(connection, manager.kind, manager.id)
      if (ticket === opening.current) setQueues(rows)
    } catch (err) {
      if (ticket !== opening.current) return
      setQueueError(errorText(err))
      setQueues(null)
    } finally {
      if (ticket === opening.current) setLoadingQueues(false)
    }
  }, [connection])

  useEffect(() => { void openQueues(selected) }, [openQueues, selected])

  // Смена менеджера закрывает открытую очередь: сообщения были из другой.
  useEffect(() => { setInbox(null) }, [selected])

  // Пришли к конкретной очереди — из поиска обмена или палитры: её
  // сообщения открываются сразу, а не строкой в отобранном списке.
  const autoOpened = useRef(false)
  useEffect(() => {
    if (autoOpened.current || !initialQuery || !queues) return
    const exact = queues.find((queue) => queue.name === initialQuery)
    if (!exact) return
    autoOpened.current = true
    setInbox(exact)
  }, [queues, initialQuery])

  const errorQueues = useMemo(
    () => (queues ?? []).filter((queue) => !(hideInternal && queue.internal) && isErrorQueue(queue.name)).length,
    [queues, hideInternal],
  )

  const visible = useMemo(() => {
    if (!queues) return []
    const needle = query.trim().toLowerCase()
    return queues.filter((queue) => {
      if (hideInternal && queue.internal) return false
      if (onlyErrors && !isErrorQueue(queue.name)) return false
      if (!needle) return true
      return queue.name.toLowerCase().includes(needle) || (queue.address ?? '').toLowerCase().includes(needle)
    })
  }, [queues, query, hideInternal, onlyErrors])

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

      <ScreenBodyRow>
        <Panel className="w-60 shrink-0 xl:w-72">
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface-2 px-3 py-2">
            <span className="text-[11px] tracking-wide text-content-subtle">{t('queues.managers')}</span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              aria-label={t('action.refresh')}
              title={t('action.refresh')}
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
                <Awaiting busy={managers.loading}>{managers.loading ? t('empty.scanning') : t('queues.noManagers')}</Awaiting>
              </p>
            )}
          </div>
        </Panel>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          {/* Панель списка очередей: поиск, служебные и обновление относятся
              к списку, а не к сообщениям. В режиме сообщений она уезжает
              целиком — иначе на экране две кнопки «Обновить», и непонятно,
              какая из них обновляет то, на что смотришь. */}
          {!inbox && (
            <div className="flex flex-wrap items-center gap-2">
              <SearchInput
                className="min-w-64 flex-1"
                value={query}
                placeholder={t('queues.search')}
                onChange={setQuery}
              />
              <Toggle checked={onlyErrors} onChange={setOnlyErrors} label={t('queues.onlyErrors', { count: errorQueues })} />
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
          )}

          <ErrorBar error={queueError} />

          {!inbox && selected && !selected.running && (
            <Notice tone="warn" small>
              {t('queues.stoppedHint', { broker: selected.broker })}
            </Notice>
          )}

          {inbox && selected ? (
            <Messages
              connection={connection}
              manager={selected}
              queue={inbox}
              queues={queues ?? []}
              environment={environment}
              onBack={() => setInbox(null)}
              onChanged={() => void openQueues(selected)}
            />
          ) : (
          <Panel className="flex-1">
            <DataTable>
              <colgroup>
                {/* Накопительные счётчики уходят на узком окне: имя очереди
                    и текущее число сообщений нужнее, чем «положено за всё время». */}
                <col />
                <col className="w-24" />
                <col className="w-28" />
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
                        {isErrorQueue(queue.name) && (
                          <Badge tone="danger" title={t('queues.errorQueue.hint')}>{t('queues.errorQueue')}</Badge>
                        )}
                        {queue.paused && <Badge tone="warn">{t('queues.paused')}</Badge>}
                        {queue.internal && <Badge>{t('queues.internal')}</Badge>}
                        {queue.durable && <Badge tone="accent">{t('queues.durable')}</Badge>}
                      </div>
                    </td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <TableMessage colSpan={6} busy={loadingQueues}>{loadingQueues ? t('empty.scanning') : t('queues.empty')}
                  </TableMessage>
                )}
              </tbody>
            </DataTable>
          </Panel>
          )}
        </div>
      </ScreenBodyRow>
    </ScreenBody>
  )
}

const RETRY_BLOCK: Record<RetryBlock, MessageKey> = {
  remote: 'queues.retryBlock.remote',
  noOrigin: 'queues.retryBlock.noOrigin',
  backToErrors: 'queues.retryBlock.backToErrors',
}

/**
 * Сообщения очереди.
 *
 * Ради этого экрана всё и затевалось: трассировку настраивают на очередь,
 * а потом хотят увидеть, что в неё легло. Отмеченные сообщения можно
 * вернуть в исходную очередь, переложить, скопировать или удалить — это
 * разбор очереди ошибок, который иначе делается по одному сообщению.
 */
function Messages({ connection, manager, queue, queues, environment, onBack, onChanged }: {
  connection: Connection
  manager: QueueManager
  queue: QueueRow
  queues: QueueRow[]
  environment: Environment | null
  onBack: () => void
  /** Сообщения ушли или появились — число в списке очередей устарело. */
  onChanged: () => void
}) {
  const { t } = useI18n()
  const [messages, setMessages] = useState<QueueMessage[]>([])
  const [full, setFull] = useState<Record<string, QueueMessage>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [auto, setAuto] = useState(false)

  const [search, setSearch] = useState('')
  /** Что нашлось в телах и по какому запросу: чужой ответ показывать нельзя. */
  const [hits, setHits] = useState<{ needle: string; found: Map<string, string> } | null>(null)
  const [searching, setSearching] = useState(false)
  const [progress, setProgress] = useState<ApiProgress | null>(null)
  const query = useDebounced(search, 250)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [action, setAction] = useState<ActionKind | null>(null)
  /** Что было отмечено, когда открыли окно: список под ним может обновиться. */
  const [acting, setActing] = useState<QueueMessage[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setMessages(uniqueById(await apiQueueMessages(connection, manager.kind, manager.id, queue.name, 200)))
    } catch (err) {
      setError(errorText(err))
      setMessages([])
    } finally {
      setLoading(false)
    }
  }, [connection, manager, queue.name])

  useEffect(() => { void load() }, [load])
  useAutoRefresh(auto, load)

  // Отметка живёт, пока сообщение в очереди: ушедшие после обновления снимаются.
  useEffect(() => {
    setPicked((prev) => {
      const present = new Set(messages.map((message) => message.id))
      const next = new Set([...prev].filter((id) => present.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [messages])

  /**
   * Отбор по тому, что уже есть в списке: идентификатор, корреляция, тип,
   * адрес ответа и свойства. Тела здесь нет — за ним идут отдельно.
   */
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return messages
    const found = hits?.needle === needle ? hits.found : null
    return messages.filter((message) => found?.has(message.id) || matchesHeader(message, needle))
  }, [messages, query, hits])

  /** Колонка «Откуда» нужна, только когда сообщения пришли из других очередей. */
  const showOrigin = useMemo(() => messages.some((message) => cameFromElsewhere(message, queue.name)), [messages, queue.name])
  const chosen = useMemo(() => messages.filter((message) => picked.has(message.id)), [messages, picked])
  const blocked = retryBlock(manager.kind, chosen)
  const allShown = visible.length > 0 && visible.every((message) => picked.has(message.id))
  const someShown = visible.some((message) => picked.has(message.id))

  const toggle = useCallback((id: string) => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleShown = useCallback(() => {
    setPicked((prev) => {
      const next = new Set(prev)
      for (const message of visible) {
        if (allShown) next.delete(message.id)
        else next.add(message.id)
      }
      return next
    })
  }, [visible, allShown])

  const openAction = useCallback((kind: ActionKind) => {
    setActing(chosen)
    setAction(kind)
  }, [chosen])

  const closeAction = useCallback((changed: boolean) => {
    setAction(null)
    if (!changed) return
    setPicked(new Set())
    void load()
    onChanged()
  }, [load, onChanged])

  const needle = query.trim()
  /** Ответ устарел, как только запрос изменился: искать нужно заново. */
  const searched = hits !== null && hits.needle === needle.toLowerCase()

  const searchBodies = useCallback(async () => {
    if (!needle) return
    setSearching(true)
    setError(null)
    setProgress(null)
    const stop = await onApiProgress(setProgress)
    try {
      const matches = await apiQueueSearch(
        connection, manager.kind, manager.id, queue.name,
        messages.map((message) => message.id), needle,
      )
      setHits({ needle: needle.toLowerCase(), found: new Map(matches.map((m) => [m.id, m.excerpt])) })
    } catch (err) {
      setError(errorText(err))
    } finally {
      void stop()
      setSearching(false)
      setProgress(null)
    }
  }, [connection, manager, queue.name, messages, needle])

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
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={onBack}><ArrowLeft size={14} weight="bold" /> {t('queues.backToQueues')}</Button>
        <span className="min-w-0 truncate font-mono text-[12.5px] font-semibold">{queue.name}</span>
        <span className="text-[11.5px] tabular-nums text-content-subtle">
          {needle
            ? t('queues.messagesShown', { visible: visible.length, total: messages.length })
            : t('queues.messagesCount', { count: messages.length })}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <AutoRefreshToggle checked={auto} onChange={setAuto} />
          <RefreshButton busy={loading} disabled={loading} onClick={() => void load()} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          className="min-w-64 flex-1"
          value={search}
          placeholder={t('queues.searchMessages')}
          onChange={setSearch}
          clearLabel={t('action.clearSearch')}
        />
        {/* Поиск по телам — отдельная кнопка, а не то же поле: тела в списке
            нет, и за каждым приходится идти на сервер. Делать это на каждое
            нажатие клавиши нельзя, а молча не делать — значит соврать, что
            в очереди ничего не нашлось. */}
        <Button
          className="min-w-52"
          disabled={!needle || searching || searched || messages.length === 0}
          title={t('queues.searchBodies.hint')}
          onClick={() => void searchBodies()}
        >
          <ButtonGlyph busy={searching}><MagnifyingGlass size={14} weight="bold" /></ButtonGlyph>
          {searched
            ? t('queues.searchBodies.done', { count: hits?.found.size ?? 0 })
            : t('queues.searchBodies', { count: messages.length })}
        </Button>
      </div>

      {searching && progress && (
        <p className="text-[11.5px] tabular-nums text-content-subtle">
          {t('queues.searchProgress', { current: progress.current, total: progress.total })}
        </p>
      )}

      <ErrorBar error={error} />

      <Panel className="flex-1">
        <DataTable>
          <colgroup>
            <col className="w-9" />
            <col className="w-44" />
            <col />
            {/* Тип и размер уходят на узком окне: без них идентификатор
                сообщения сжимался до пустой колонки. */}
            <col className="hidden w-28 xl:table-column" />
            <col className="hidden w-24 xl:table-column" />
            {/* Под «Состояние» встают метки «Постоянное» и «Повторное»,
                и заголовок сам по себе шире, чем узкая колонка. */}
            <col className="w-32" />
          </colgroup>
          <THead>
              <th className="px-3 py-2">
                <Checkbox
                  aria-label={t('queues.selectAll')}
                  title={t('queues.selectAll')}
                  checked={allShown}
                  ref={(box) => { if (box) box.indeterminate = someShown && !allShown }}
                  disabled={visible.length === 0}
                  onChange={toggleShown}
                />
              </th>
              <Th>{t('logs.time')}</Th>
              <Th>{t('queues.messageId')}</Th>
              <Th className="hidden xl:table-cell">{t('queues.messageType')}</Th>
              <Th align="right" className="hidden xl:table-cell">{t('zip.size')}</Th>
              <Th>{t('table.state')}</Th>
            </THead>
          <tbody>
            {visible.map((message) => {
              const loaded = full[message.id]
              const shown = open === message.id
              const excerpt = hits?.needle === needle.toLowerCase() ? hits.found.get(message.id) : undefined
              return (
                <Fragment key={message.id}>
                  <tr
                    onClick={() => void expand(message)}
                    className={cx(
                      'cursor-pointer align-top',
                      shown ? 'bg-surface-2/60' : 'border-b border-line/60 hover:bg-surface-2',
                      picked.has(message.id) && !shown && 'bg-accent/6',
                    )}
                  >
                    <td className="px-3 py-1.5" onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        aria-label={t('queues.selectMessage')}
                        checked={picked.has(message.id)}
                        onChange={() => toggle(message.id)}
                      />
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[11px] text-content-subtle">
                      {message.timestamp?.replace('T', ' ').slice(0, 23) ?? '—'}
                    </td>
                    <td className="px-3 py-1.5" title={message.id}>
                      <div className="truncate font-mono text-[11px]">{message.id}</div>
                      {/* Откуда сообщение попало сюда — второй строкой, а не
                          колонкой: отдельная колонка на узком окне съедала
                          идентификатор целиком. */}
                      {showOrigin && (
                        <div className="truncate text-[10.5px] text-content-subtle" title={t('queues.origin.hint')}>
                          {message.originalQueue
                            ? t('queues.origin.value', { queue: message.originalQueue })
                            : t('queues.origin.unknown')}
                        </div>
                      )}
                      {/* Вырезка из тела: видно, за что зацепился поиск,
                          и не надо раскрывать каждое сообщение подряд. */}
                      {excerpt && (
                        <div className="mt-0.5 truncate font-mono text-[10.5px] text-content-subtle">
                          <Highlight text={excerpt} needle={needle} />
                        </div>
                      )}
                    </td>
                    <td className="hidden px-3 py-1.5 text-content-muted xl:table-cell">{message.bodyType ?? '—'}</td>
                    <td className="hidden px-3 py-1.5 text-right tabular-nums xl:table-cell">{message.size}</td>
                    <td className="px-3 py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {message.persistent && <Badge tone="accent">{t('queues.persistent')}</Badge>}
                        {message.redelivered && <Badge tone="warn">{t('queues.redelivered')}</Badge>}
                      </div>
                    </td>
                  </tr>

                  {shown && (
                    <tr className="border-b border-line/60 bg-surface-2/60">
                      <td colSpan={6} className="px-3 pb-3">
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
            {visible.length === 0 && (
              <TableMessage colSpan={6} busy={loading}>{loading ? t('empty.scanning') : needle ? t('queues.noMatches') : t('queues.noMessages')}
              </TableMessage>
            )}
          </tbody>
        </DataTable>
      </Panel>

      {/* Панель действий — под таблицей: появляясь над ней, она сдвигала
          строки, и следующая отметка попадала не в ту строку. */}
      {chosen.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-accent/30 bg-accent/8 px-3 py-2 shadow-sm">
          <span className="text-[12px] font-medium tabular-nums">{t('queues.selected', { count: chosen.length })}</span>
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>{t('queues.clearSelection')}</Button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span title={blocked ? t(RETRY_BLOCK[blocked]) : undefined}>
              <Button size="sm" variant="primary" disabled={blocked !== null} onClick={() => openAction('retry')}>
                <ArrowBendUpLeft size={13} weight="bold" /> {t('queues.action.retry')}
              </Button>
            </span>
            <Button size="sm" onClick={() => openAction('move')}>
              <ArrowRight size={13} weight="bold" /> {t('queues.action.move')}
            </Button>
            <Button size="sm" onClick={() => openAction('copy')}>
              <Copy size={13} weight="bold" /> {t('queues.action.copy')}
            </Button>
            <Button size="sm" variant="danger" onClick={() => openAction('delete')}>
              <Trash size={13} weight="bold" /> {t('queues.action.delete')}
            </Button>
          </div>
        </div>
      )}

      <MessageActionDialog
        kind={action}
        connection={connection}
        manager={manager}
        queue={queue.name}
        messages={acting}
        queues={queues.filter((item) => !item.internal).map((item) => ({ name: item.name, messages: item.messages }))}
        environment={environment}
        onClose={closeAction}
      />
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

/**
 * Одно сообщение — одна строка. Расширенный менеджер, пока в очередь пишут,
 * иногда отдаёт одно и то же сообщение дважды, а по идентификатору строятся
 * и строки таблицы, и отметки.
 */
function uniqueById(messages: QueueMessage[]): QueueMessage[] {
  const seen = new Set<string>()
  return messages.filter((message) => !seen.has(message.id) && Boolean(seen.add(message.id)))
}

/**
 * Совпадение по тому, что видно в списке.
 *
 * Тела здесь нет — за ним ходят отдельной кнопкой, — но идентификатор,
 * корреляция и свойства находятся мгновенно, и чаще всего ищут именно их.
 */
function matchesHeader(message: QueueMessage, needle: string): boolean {
  if (message.id.toLowerCase().includes(needle)) return true
  if ((message.correlationId ?? '').toLowerCase().includes(needle)) return true
  if ((message.bodyType ?? '').toLowerCase().includes(needle)) return true
  if ((message.replyTo ?? '').toLowerCase().includes(needle)) return true
  return message.properties.some(
    (property) =>
      property.name.toLowerCase().includes(needle) || property.value.toLowerCase().includes(needle),
  )
}
