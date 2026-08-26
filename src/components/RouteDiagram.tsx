import { Fragment } from 'react'

import { useI18n, type MessageKey, type Translate } from '../i18n'
import type { RouteNode } from '../types'
import { cx } from './ui'

/**
 * Схема СОПС: поток сообщения сверху вниз, ветвления — в стороны.
 *
 * Раскладка намеренно не считает координаты: вложенность в схемах бывает
 * произвольной, и колонки на flex переживают её без переполнений и наездов,
 * в отличие от заранее посчитанного графа.
 */

interface Props {
  nodes: RouteNode[]
  selected: RouteNode | null
  onSelect: (node: RouteNode) => void
}

/** Шаги, внутри которых лежит вложенный поток, а не следующий шаг. */
const FRAMES = new Set([
  'split', 'loop', 'filter', 'onException', 'aggregate', 'transacted', 'multicast',
  'loadBalance', 'circuitBreaker', 'onFallback', 'pipeline', 'policy', 'idempotentConsumer',
  'resequence', 'saga', 'step', 'threads', 'whenSkipSendToEndpoint',
])

const HANDLERS = new Set(['doCatch', 'doFinally'])

const ICONS: Record<string, string> = {
  from: '▶',
  to: '➔',
  toD: '➔',
  log: '✎',
  setHeader: '⊞',
  setProperty: '⊞',
  setBody: '⊞',
  removeHeaders: '⌫',
  removeHeader: '⌫',
  removeProperties: '⌫',
  transform: 'ƒ',
  bean: '⚙',
  process: '⚙',
  marshal: '⇄',
  unmarshal: '⇄',
  convertBodyTo: '⇄',
  choice: '◈',
  when: '◈',
  otherwise: '◈',
  filter: '▽',
  split: '⑂',
  loop: '↻',
  doTry: '⛊',
  doCatch: '⚠',
  doFinally: '⤓',
  throwException: '✖',
  stop: '■',
  wireTap: '⑃',
  recipientList: '⋔',
  pollEnrich: '⇤',
  enrich: '⇤',
  onException: '⚠',
  aggregate: '⊕',
  transacted: '⛁',
}

/** Тон карточки: вход, выход, ветвление и ошибки должны читаться без чтения. */
function tone(kind: string): string {
  if (kind === 'from') return 'border-positive/40 bg-positive/8'
  if (kind === 'to' || kind === 'toD' || kind === 'recipientList' || kind === 'wireTap') {
    return 'border-accent/40 bg-accent/8'
  }
  if (kind === 'throwException' || kind === 'stop' || kind === 'doCatch' || kind === 'onException') {
    return 'border-negative/35 bg-negative/8'
  }
  if (kind === 'choice' || kind === 'filter') return 'border-caution/40 bg-caution/8'
  return 'border-line-strong bg-surface-2'
}

/** Понятное имя шага: у элементов Camel есть привычные русские названия. */
export function kindLabel(kind: string, t: Translate): string {
  const key = `route.kind.${kind}` as MessageKey
  const text = t(key)
  return text === key ? kind : text
}

/** Короткий адрес для карточки: без параметров запроса и без хвоста. */
export function shortUri(uri: string): string {
  const cut = uri.split('?')[0]
  return cut.length > 68 ? `${cut.slice(0, 66)}…` : cut
}

function firstLine(text: string): string {
  const line = text.split('\n').find((item) => item.trim().length > 0) ?? ''
  return line.length > 90 ? `${line.slice(0, 88)}…` : line.trim()
}

/** Одна строка под заголовком карточки — самое важное про шаг. */
function summary(node: RouteNode): string | null {
  if (node.uri) return shortUri(node.uri)
  if (node.expression) return firstLine(node.expression.text)
  if (node.format) return node.format
  if (node.exceptions.length > 0) return node.exceptions.join(', ')
  const name = node.attributes.find((item) => item.name === 'name' || item.name === 'headerName')
  if (name) return name.value
  const message = node.attributes.find((item) => item.name === 'message')
  if (message) return firstLine(message.value)
  if (node.description) return firstLine(node.description)
  return null
}

export function RouteDiagram({ nodes, selected, onSelect }: Props) {
  return (
    <div className="min-w-max p-5">
      <Sequence nodes={nodes} selected={selected} onSelect={onSelect} />
    </div>
  )
}

function Sequence({ nodes, selected, onSelect }: Props) {
  const { t } = useI18n()
  if (nodes.length === 0) {
    return <div className="rounded-lg border border-dashed border-line-strong px-4 py-3 text-[11.5px] text-content-subtle">{t('route.emptyBranch')}</div>
  }
  return (
    <div className="flex flex-col items-start">
      {nodes.map((node, index) => (
        <Fragment key={`${node.kind}-${node.line}-${index}`}>
          {index > 0 && <Connector />}
          <Step node={node} selected={selected} onSelect={onSelect} />
        </Fragment>
      ))}
    </div>
  )
}

function Connector() {
  return (
    <div className="ml-[26px] flex h-5 w-3 flex-col items-center">
      <span className="w-px flex-1 bg-line-strong" />
      <span className="-mt-px text-[9px] leading-none text-line-strong">▼</span>
    </div>
  )
}

function Step({ node, selected, onSelect }: { node: RouteNode; selected: RouteNode | null; onSelect: (node: RouteNode) => void }) {
  if (node.kind === 'choice') return <Choice node={node} selected={selected} onSelect={onSelect} />
  if (node.kind === 'doTry') return <TryBlock node={node} selected={selected} onSelect={onSelect} />
  if (FRAMES.has(node.kind) && node.children.length > 0) {
    return <Frame node={node} selected={selected} onSelect={onSelect} />
  }
  return <Card node={node} selected={selected} onSelect={onSelect} />
}

function Card({ node, selected, onSelect, compact }: {
  node: RouteNode
  selected: RouteNode | null
  onSelect: (node: RouteNode) => void
  compact?: boolean
}) {
  const { t } = useI18n()
  const title = node.label ?? kindLabel(node.kind, t)
  const note = summary(node)
  const active = selected === node

  return (
    <button
      type="button"
      onClick={() => onSelect(node)}
      title={node.uri ?? undefined}
      className={cx(
        'flex w-72 items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition',
        tone(node.kind),
        active ? 'ring-2 ring-accent' : 'hover:border-content-subtle',
        compact && 'w-64',
      )}
    >
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-surface text-[12px] text-content-muted">
        {ICONS[node.kind] ?? '▪'}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium">{title}</span>
        <span className="block truncate text-[10.5px] text-content-subtle">
          {node.label ? kindLabel(node.kind, t) : node.component ?? kindLabel(node.kind, t)}
        </span>
        {note && <span className="mt-1 block truncate font-mono text-[10.5px] text-content-muted">{note}</span>}
      </span>
    </button>
  )
}

/** Ветвление: условия идут колонками, каждая со своим потоком. */
function Choice({ node, selected, onSelect }: { node: RouteNode; selected: RouteNode | null; onSelect: (node: RouteNode) => void }) {
  const { t } = useI18n()
  return (
    <div className="flex flex-col items-start">
      <Card node={node} selected={selected} onSelect={onSelect} />
      <div className="ml-[26px] h-3 w-px bg-line-strong" />
      <div className="flex items-stretch gap-3 rounded-xl border border-caution/30 bg-caution/5 p-3">
        {node.children.map((branch, index) => (
          <div key={`${branch.kind}-${branch.line}-${index}`} className="flex min-w-0 flex-col gap-2">
            <button
              type="button"
              onClick={() => onSelect(branch)}
              title={branch.expression?.text}
              className={cx(
                'w-72 rounded-lg border px-2.5 py-1.5 text-left transition',
                branch.kind === 'otherwise'
                  ? 'border-line-strong bg-surface-2'
                  : 'border-caution/40 bg-caution/10',
                selected === branch ? 'ring-2 ring-accent' : 'hover:border-content-subtle',
              )}
            >
              <span className="block text-[10.5px] uppercase tracking-wide text-content-subtle">
                {kindLabel(branch.kind, t)}
              </span>
              <span className="block truncate font-mono text-[11px] text-content">
                {branch.expression ? firstLine(branch.expression.text) : t('route.anyMessage')}
              </span>
            </button>
            <Sequence nodes={branch.children} selected={selected} onSelect={onSelect} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Попытка с обработкой ошибок: тело и обработчики — разные части одного блока. */
function TryBlock({ node, selected, onSelect }: { node: RouteNode; selected: RouteNode | null; onSelect: (node: RouteNode) => void }) {
  const { t } = useI18n()
  const body = node.children.filter((child) => !HANDLERS.has(child.kind))
  const handlers = node.children.filter((child) => HANDLERS.has(child.kind))

  return (
    <div className="flex flex-col items-start">
      <Card node={node} selected={selected} onSelect={onSelect} />
      <div className="ml-[26px] h-3 w-px bg-line-strong" />
      <div className="flex flex-col gap-3 rounded-xl border border-line-strong bg-surface-2/40 p-3">
        <Sequence nodes={body} selected={selected} onSelect={onSelect} />
        {handlers.map((handler, index) => (
          <div
            key={`${handler.kind}-${handler.line}-${index}`}
            className={cx(
              'flex flex-col gap-2 rounded-lg border p-3',
              handler.kind === 'doCatch' ? 'border-negative/35 bg-negative/5' : 'border-line-strong bg-surface/60',
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(handler)}
              className={cx(
                'text-left text-[11px]',
                selected === handler ? 'text-accent-content' : 'text-content-subtle hover:text-content',
              )}
            >
              <span className="font-medium">{kindLabel(handler.kind, t)}</span>
              {handler.exceptions.length > 0 && (
                <span className="ml-2 font-mono text-[10.5px]">{handler.exceptions.join(', ')}</span>
              )}
            </button>
            <Sequence nodes={handler.children} selected={selected} onSelect={onSelect} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Шаг, внутри которого идёт вложенный поток: разделение, цикл, фильтр. */
function Frame({ node, selected, onSelect }: { node: RouteNode; selected: RouteNode | null; onSelect: (node: RouteNode) => void }) {
  return (
    <div className="flex flex-col items-start">
      <Card node={node} selected={selected} onSelect={onSelect} />
      <div className="ml-[26px] h-3 w-px bg-line-strong" />
      <div className="rounded-xl border border-line-strong bg-surface-2/40 p-3">
        <Sequence nodes={node.children} selected={selected} onSelect={onSelect} />
      </div>
    </div>
  )
}
