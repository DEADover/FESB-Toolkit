import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ArrowBendUpLeft, ArrowRight, Copy, Trash } from '@phosphor-icons/react'

import { useI18n, type MessageKey } from '../i18n'
import { apiQueueMessagesAction, errorText } from '../lib/api'
import type { Environment } from '../lib/connection'
import { groupByOrigin, isErrorQueue } from '../lib/deadLetters'
import type { Connection, MessageAction, MessageActionResult, QueueManager, QueueMessage } from '../types'
import { Badge, Button, ButtonGlyph, cx, Modal, Notice, Select } from './ui'

export type ActionKind = MessageAction['kind']

const TITLE: Record<ActionKind, MessageKey> = {
  retry: 'messageAction.title.retry',
  move: 'messageAction.title.move',
  copy: 'messageAction.title.copy',
  delete: 'messageAction.title.delete',
}
const INTRO: Record<ActionKind, MessageKey> = {
  retry: 'messageAction.intro.retry',
  move: 'messageAction.intro.move',
  copy: 'messageAction.intro.copy',
  delete: 'messageAction.intro.delete',
}
const RUN: Record<ActionKind, MessageKey> = {
  retry: 'messageAction.run.retry',
  move: 'messageAction.run.move',
  copy: 'messageAction.run.copy',
  delete: 'messageAction.run.delete',
}
const DONE: Record<ActionKind, MessageKey> = {
  retry: 'messageAction.done.retry',
  move: 'messageAction.done.move',
  copy: 'messageAction.done.copy',
  delete: 'messageAction.done.delete',
}
const GLYPH = { retry: ArrowBendUpLeft, move: ArrowRight, copy: Copy, delete: Trash } as const

interface Props {
  /** `null` — окно закрыто. */
  kind: ActionKind | null
  connection: Connection
  manager: QueueManager
  queue: string
  messages: QueueMessage[]
  /** Очереди того же менеджера — куда можно переложить. */
  queues: Array<{ name: string; messages: number }>
  environment: Environment | null
  /** `changed` — в очереди что-то поменялось, список надо перечитать. */
  onClose: (changed: boolean) => void
}

/**
 * Предпросмотр и подтверждение действия с отмеченными сообщениями.
 *
 * Сначала видно, что и куда уйдёт, и только потом — запрос к шине. Все
 * сообщения уходят одним запросом: шина делает это сама и отвечает, сколько
 * обработала, а по одному двести сообщений ходили бы минуту.
 */
export function MessageActionDialog({ kind, connection, manager, queue, messages, queues, environment, onClose }: Props) {
  const { t } = useI18n()
  const [target, setTarget] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<MessageActionResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const targets = useMemo(
    () => queues.filter((item) => item.name !== queue).sort((a, b) => a.name.localeCompare(b.name)),
    [queues, queue],
  )
  const origins = useMemo(() => groupByOrigin(messages), [messages])

  // Куда переложить, по умолчанию — откуда сообщения чаще всего пришли:
  // чаще всего их и возвращают руками, когда брокер переотправлять не умеет.
  // Сбрасывается только при открытии: список очередей приходит новым
  // массивом на каждую перерисовку экрана, и итог иначе пропадал бы.
  const latest = useRef({ origins, targets })
  latest.current = { origins, targets }
  useEffect(() => {
    if (kind === null) return
    setResult(null)
    setError(null)
    const { origins, targets } = latest.current
    const usual = origins.find((group) => group.queue && !isErrorQueue(group.queue) && targets.some((item) => item.name === group.queue))?.queue
    setTarget(usual ?? targets[0]?.name ?? '')
  }, [kind])

  const needsTarget = kind === 'move' || kind === 'copy'
  const prod = environment === 'prod'

  const run = useCallback(async () => {
    if (!kind) return
    const action: MessageAction = kind === 'move' || kind === 'copy' ? { kind, to: target } : { kind }
    setRunning(true)
    setError(null)
    try {
      setResult(await apiQueueMessagesAction(connection, manager.kind, manager.id, queue, messages.map((message) => message.id), action))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setRunning(false)
    }
  }, [kind, target, connection, manager, queue, messages])

  if (kind === null) return null
  const Glyph = GLYPH[kind]
  const done = result !== null

  const footer = done ? (
    <Button variant="primary" onClick={() => onClose(true)}>{t('action.close')}</Button>
  ) : (
    <>
      <Button variant="ghost" disabled={running} onClick={() => onClose(false)}>{t('action.cancel')}</Button>
      <Button
        variant={kind === 'delete' || prod ? 'danger' : 'primary'}
        className="min-w-44"
        disabled={running || messages.length === 0 || (needsTarget && !target)}
        onClick={() => void run()}
      >
        <ButtonGlyph busy={running}><Glyph size={14} weight="bold" /></ButtonGlyph>
        {t(RUN[kind], { count: messages.length })}
      </Button>
    </>
  )

  return (
    <Modal
      open
      onClose={() => !running && onClose(done)}
      closeLabel={t('action.close')}
      title={t(TITLE[kind])}
      width="wide"
      footer={footer}
    >
      <div className="space-y-3 text-[13px] leading-relaxed">
        <p className="text-content-muted">{t(INTRO[kind], { queue })}</p>

        {prod && !done && <Notice tone="warn">{t(kind === 'delete' ? 'messageAction.prod.delete' : 'messageAction.prod')}</Notice>}
        {error && <Notice tone="danger">{error}</Notice>}
        {result && (
          <Notice tone={result.done < result.requested ? 'warn' : 'ok'}>
            {result.done < result.requested
              ? t('messageAction.partly', { done: result.done, requested: result.requested })
              : t(DONE[kind], { count: result.done })}
          </Notice>
        )}

        {kind === 'retry' && (
          <div className="rounded-lg border border-line bg-surface-2/60 px-3 py-2">
            <div className="mb-1 text-[11px] text-content-subtle">{t('messageAction.where')}</div>
            {origins.map((group) => (
              <div key={group.queue ?? ''} className="flex items-center gap-2 py-0.5">
                <span className="font-mono text-[12px] text-content-muted">{queue}</span>
                <ArrowRight size={12} className="text-content-subtle" />
                <span className="font-mono text-[12px] font-medium">{group.queue ?? '—'}</span>
                <Badge className="ml-auto">{t('messageAction.count', { count: group.count })}</Badge>
              </div>
            ))}
          </div>
        )}

        {needsTarget && (
          done ? (
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12px] text-content-muted">{queue}</span>
              <ArrowRight size={12} className="text-content-subtle" />
              <span className="font-mono text-[12px] font-medium">{target}</span>
            </div>
          ) : targets.length > 0 ? (
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12px] text-content-muted">{queue}</span>
              <ArrowRight size={12} className="text-content-subtle" />
              <Select
                className="w-80"
                ariaLabel={t('messageAction.target')}
                label={t('messageAction.target')}
                value={target}
                options={targets.map((item) => ({ id: item.name, label: item.name, hint: String(item.messages) }))}
                onChange={setTarget}
              />
            </div>
          ) : (
            <Notice tone="warn">{t('messageAction.noTargets')}</Notice>
          )
        )}

        <div className="max-h-64 overflow-auto rounded-lg border border-line">
          <table className="w-full table-fixed text-[12px]">
            <colgroup>
              <col className="w-44" />
              <col />
              <col className="w-48" />
            </colgroup>
            <tbody>
              {messages.map((message) => (
                <tr key={message.id} className="border-t border-line/60 first:border-t-0">
                  <td className="px-3 py-1.5 font-mono text-[11px] text-content-subtle">
                    {message.timestamp?.replace('T', ' ').slice(0, 19) ?? '—'}
                  </td>
                  <td className="truncate px-3 py-1.5 font-mono text-[11px]" title={message.id}>{message.id}</td>
                  <td className={cx('truncate px-3 py-1.5 font-mono text-[11px]', !message.originalQueue && 'text-content-subtle')}>
                    {message.originalQueue ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  )
}
