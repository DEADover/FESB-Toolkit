import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useI18n, type MessageKey, type Translate } from '../i18n'
import type { RouteNode } from '../types'
import { cx } from './ui'

/**
 * Схема СОПС в духе редакторов интеграционных потоков: слева направо,
 * ветвления — ромбами со стрелками, вложенные потоки — рамками.
 *
 * Раскладка считается здесь же, а не отдаётся флексбоксу: только зная точные
 * координаты, можно провести связи ортогональными линиями и свести ветки
 * обратно в одну точку. Коробки при этом остаются обычными элементами —
 * их проще стилизовать и они сами читаются экранным диктором.
 */

// Размеры в единицах схемы, до масштабирования.
const EVENT = 56
const EVENT_LABEL = 30
const TASK_W = 178
const TASK_H = 86
const GATE = 54
const CHIP_W = 152
const CHIP_H = 46
const STUB_W = 132
const STUB_H = 40
const H_GAP = 54
const V_GAP = 26
const PAD = 20
const HEADER = 30

/** Шаги, внутри которых лежит вложенный поток, а не следующий шаг. */
const FRAMES = new Set([
  'split', 'loop', 'filter', 'onException', 'aggregate', 'transacted', 'multicast',
  'loadBalance', 'circuitBreaker', 'onFallback', 'pipeline', 'policy', 'idempotentConsumer',
  'resequence', 'saga', 'step', 'threads', 'whenSkipSendToEndpoint',
])

const HANDLERS = new Set(['doCatch', 'doFinally'])
const ENDS = new Set(['stop', 'throwException'])

const ICONS: Record<string, string> = {
  from: '▶', to: '➔', toD: '➔', log: '✎',
  setHeader: '⊞', setProperty: '⊞', setBody: '⊞',
  removeHeaders: '⌫', removeHeader: '⌫', removeProperties: '⌫',
  transform: 'ƒ', bean: '⚙', process: '⚙',
  marshal: '⇄', unmarshal: '⇄', convertBodyTo: '⇄',
  choice: '◈', when: '◈', otherwise: '◈', filter: '▽',
  split: '⑂', loop: '↻',
  doTry: '⛊', doCatch: '⚠', doFinally: '⤓', onException: '⚠',
  throwException: '✖', stop: '■',
  wireTap: '⑃', recipientList: '⋔', pollEnrich: '⇤', enrich: '⇤',
  aggregate: '⊕', transacted: '⛁',
}

export type Shape = 'start' | 'end' | 'task' | 'gateway' | 'branch' | 'group' | 'stub'

interface Box {
  key: string
  node: RouteNode | null
  shape: Shape
  x: number
  y: number
  w: number
  h: number
  /** Заголовок рамки: у групп он рисуется полоской сверху. */
  frameLabel?: string
  tone: 'plain' | 'entry' | 'send' | 'branch' | 'error'
}

interface Edge {
  key: string
  d: string
}

interface Size {
  w: number
  h: number
  /** Высота линии потока внутри блока — по ней стыкуются соседи. */
  axis: number
}

interface Layout {
  boxes: Box[]
  edges: Edge[]
  width: number
  height: number
}

/** Понятное имя шага: у элементов Camel есть привычные названия. */
export function kindLabel(kind: string, t: Translate): string {
  const key = `route.kind.${kind}` as MessageKey
  const text = t(key)
  return text === key ? kind : text
}

/** Транспорт из адреса: `eik-ed://…` → `eik-ed`. В CPI это назвали бы адаптером. */
export function scheme(uri: string): string | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+._-]*):/.exec(uri.trim())
  return match ? match[1] : null
}

export function shortUri(uri: string): string {
  const cut = uri.split('?')[0]
  return cut.length > 60 ? `${cut.slice(0, 58)}…` : cut
}

function firstLine(text: string, limit = 64): string {
  const line = text.split('\n').find((item) => item.trim().length > 0) ?? ''
  const trimmed = line.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed
}

/** Одна строка под заголовком карточки — самое важное про шаг. */
export function summary(node: RouteNode): string | null {
  if (node.uri) return shortUri(node.uri)
  if (node.expression) return firstLine(node.expression.text)
  if (node.format) return node.format
  if (node.exceptions.length > 0) return node.exceptions.join(', ')
  const named = node.attributes.find((item) => item.name === 'name' || item.name === 'headerName')
  if (named) return named.value
  const message = node.attributes.find((item) => item.name === 'message')
  if (message) return firstLine(message.value)
  if (node.description) return firstLine(node.description)
  return null
}

function toneOf(kind: string): Box['tone'] {
  if (kind === 'from') return 'entry'
  if (kind === 'to' || kind === 'toD' || kind === 'recipientList' || kind === 'wireTap') return 'send'
  if (ENDS.has(kind) || kind === 'doCatch' || kind === 'onException') return 'error'
  if (kind === 'choice' || kind === 'filter' || kind === 'when' || kind === 'otherwise') return 'branch'
  return 'plain'
}

function isFrame(node: RouteNode): boolean {
  return node.kind === 'doTry' || (FRAMES.has(node.kind) && node.children.length > 0)
}

// ───────────────────────────── раскладка ─────────────────────────────

/**
 * Замеры кэшируются: размер поддерева спрашивают и при измерении родителя,
 * и при его расстановке, а у вложенных веток это множится с каждым уровнем.
 * Узлы приходят из разбора и не меняются, поэтому WeakMap безопасен.
 */
const sizeOfNode = new WeakMap<RouteNode, Size>()
const sizeOfList = new WeakMap<RouteNode[], Size>()

function measure(node: RouteNode): Size {
  const cached = sizeOfNode.get(node)
  if (cached) return cached
  const size = computeSize(node)
  sizeOfNode.set(node, size)
  return size
}

function computeSize(node: RouteNode): Size {
  if (node.kind === 'from' || ENDS.has(node.kind)) {
    return { w: EVENT, h: EVENT + EVENT_LABEL, axis: EVENT / 2 }
  }
  if (node.kind === 'choice') return measureChoice(node)
  if (node.kind === 'doTry') return measureTry(node)
  if (isFrame(node)) {
    const inner = measureSequence(node.children)
    return { w: inner.w + PAD * 2, h: inner.h + PAD * 2 + HEADER, axis: HEADER + PAD + inner.axis }
  }
  return { w: TASK_W, h: TASK_H, axis: TASK_H / 2 }
}

function measureSequence(nodes: RouteNode[]): Size {
  const cached = sizeOfList.get(nodes)
  if (cached) return cached
  const size = computeSequence(nodes)
  sizeOfList.set(nodes, size)
  return size
}

function computeSequence(nodes: RouteNode[]): Size {
  if (nodes.length === 0) return { w: STUB_W, h: STUB_H, axis: STUB_H / 2 }
  const sizes = nodes.map(measure)
  const w = sizes.reduce((total, size) => total + size.w, 0) + H_GAP * (sizes.length - 1)
  const above = Math.max(...sizes.map((size) => size.axis))
  const below = Math.max(...sizes.map((size) => size.h - size.axis))
  return { w, h: above + below, axis: above }
}

/** Ветка = плашка с условием, за ней её собственный поток. */
function measureBranch(branch: RouteNode): Size {
  const inner = measureSequence(branch.children)
  const above = Math.max(CHIP_H / 2, inner.axis)
  const below = Math.max(CHIP_H / 2, inner.h - inner.axis)
  return { w: CHIP_W + H_GAP + inner.w, h: above + below, axis: above }
}

/** Ветка обрывается сама: последний её шаг — остановка или исключение. */
function isTerminal(branch: RouteNode): boolean {
  const last = branch.children[branch.children.length - 1]
  return last !== undefined && ENDS.has(last.kind)
}

function measureChoice(node: RouteNode): Size {
  const branches = node.children.map(measureBranch)
  const inner = Math.max(STUB_W, ...branches.map((branch) => branch.w))
  const stack = branches.reduce((total, branch) => total + branch.h, 0) + V_GAP * Math.max(0, branches.length - 1)
  const h = Math.max(stack, GATE)
  // Если все ветки обрываются, сводить нечего — ромб слияния не нужен.
  const merge = node.children.every(isTerminal) ? 0 : H_GAP + GATE
  return { w: GATE + H_GAP + inner + merge, h, axis: h / 2 }
}

function measureTry(node: RouteNode): Size {
  const body = measureSequence(node.children.filter((child) => !HANDLERS.has(child.kind)))
  const handlers = node.children
    .filter((child) => HANDLERS.has(child.kind))
    .map((handler) => measureSequence(handler.children))
  const innerW = Math.max(body.w, ...handlers.map((size) => size.w + PAD * 2))
  const innerH = handlers.reduce((total, size) => total + V_GAP + size.h + PAD * 2 + HEADER, body.h)
  return { w: innerW + PAD * 2, h: innerH + PAD * 2 + HEADER, axis: HEADER + PAD + body.axis }
}

/** Ортогональная связь: вправо, по вертикали, снова вправо. */
function elbow(x1: number, y1: number, x2: number, y2: number): string {
  if (Math.abs(y1 - y2) < 0.5) return `M ${x1} ${y1} L ${x2} ${y2}`
  const mid = x1 + Math.max(16, (x2 - x1) / 2)
  return `M ${x1} ${y1} L ${mid} ${y1} L ${mid} ${y2} L ${x2} ${y2}`
}

class Painter {
  boxes: Box[] = []
  edges: Edge[] = []
  private seq = 0

  private key(prefix: string): string {
    this.seq += 1
    return `${prefix}-${this.seq}`
  }

  box(node: RouteNode | null, shape: Shape, x: number, y: number, w: number, h: number, extra?: Partial<Box>) {
    this.boxes.push({
      key: this.key(shape),
      node,
      shape,
      x,
      y,
      w,
      h,
      tone: node ? toneOf(node.kind) : 'plain',
      ...extra,
    })
  }

  edge(x1: number, y1: number, x2: number, y2: number) {
    this.edges.push({ key: this.key('edge'), d: elbow(x1, y1, x2, y2) })
  }

  /** Ставит узел так, чтобы линия потока прошла на высоте `axis`. */
  place(node: RouteNode, x: number, axis: number): Size {
    const size = measure(node)
    const top = axis - size.axis

    if (node.kind === 'from' || ENDS.has(node.kind)) {
      this.box(node, node.kind === 'from' ? 'start' : 'end', x, axis - EVENT / 2, EVENT, EVENT)
      return size
    }

    if (node.kind === 'choice') {
      this.placeChoice(node, x, axis, size)
      return size
    }

    if (node.kind === 'doTry') {
      this.placeTry(node, x, top, size)
      return size
    }

    if (isFrame(node)) {
      this.box(node, 'group', x, top, size.w, size.h, { frameLabel: node.label ?? node.kind })
      this.placeSequence(node.children, x + PAD, top + HEADER + PAD + measureSequence(node.children).axis)
      return size
    }

    this.box(node, 'task', x, axis - TASK_H / 2, TASK_W, TASK_H)
    return size
  }

  placeSequence(nodes: RouteNode[], x: number, axis: number): Size {
    const size = measureSequence(nodes)
    if (nodes.length === 0) {
      this.box(null, 'stub', x, axis - STUB_H / 2, STUB_W, STUB_H)
      return size
    }

    let cursor = x
    let previous: { x: number; y: number } | null = null
    for (const node of nodes) {
      const placed = this.place(node, cursor, axis)
      if (previous) this.edge(previous.x, previous.y, cursor, axis)
      // Событие уже, чем задача: связь выходит из его правого края.
      previous = { x: cursor + placed.w, y: axis }
      cursor += placed.w + H_GAP
    }
    return size
  }

  private placeChoice(node: RouteNode, x: number, axis: number, size: Size) {
    const gateX = x
    const branches = node.children
    const merging = branches.length > 0 && !branches.every(isTerminal)
    const joinX = x + size.w - GATE
    this.box(node, 'gateway', gateX, axis - GATE / 2, GATE, GATE)

    if (branches.length === 0) return

    const sizes = branches.map(measureBranch)
    const stack = sizes.reduce((total, item) => total + item.h, 0) + V_GAP * (sizes.length - 1)
    let top = axis - stack / 2

    branches.forEach((branch, index) => {
      const branchSize = sizes[index]
      const branchAxis = top + branchSize.axis
      const chipX = gateX + GATE + H_GAP

      this.box(branch, 'branch', chipX, branchAxis - CHIP_H / 2, CHIP_W, CHIP_H)
      this.edge(gateX + GATE, axis, chipX, branchAxis)

      const inner = this.placeSequence(branch.children, chipX + CHIP_W + H_GAP, branchAxis)
      this.edge(chipX + CHIP_W, branchAxis, chipX + CHIP_W + H_GAP, branchAxis)
      // Ветка, оборвавшаяся остановкой или исключением, никуда дальше не идёт.
      if (merging && !isTerminal(branch)) {
        this.edge(chipX + CHIP_W + H_GAP + inner.w, branchAxis, joinX, axis)
      }

      top += branchSize.h + V_GAP
    })

    if (merging) this.box(node, 'gateway', joinX, axis - GATE / 2, GATE, GATE)
  }

  private placeTry(node: RouteNode, x: number, top: number, size: Size) {
    const body = node.children.filter((child) => !HANDLERS.has(child.kind))
    const handlers = node.children.filter((child) => HANDLERS.has(child.kind))
    const bodySize = measureSequence(body)

    this.box(node, 'group', x, top, size.w, size.h, { frameLabel: node.label ?? node.kind })
    this.placeSequence(body, x + PAD, top + HEADER + PAD + bodySize.axis)

    let cursor = top + HEADER + PAD + bodySize.h
    for (const handler of handlers) {
      const inner = measureSequence(handler.children)
      const height = inner.h + PAD * 2 + HEADER
      cursor += V_GAP
      this.box(handler, 'group', x + PAD, cursor, size.w - PAD * 2, height, {
        frameLabel: handler.kind,
      })
      this.placeSequence(handler.children, x + PAD * 2, cursor + HEADER + PAD + inner.axis)
      cursor += height
    }
  }
}

export function layoutRoute(nodes: RouteNode[]): Layout {
  const painter = new Painter()
  const size = measureSequence(nodes)
  painter.placeSequence(nodes, PAD, PAD + size.axis)
  return {
    boxes: painter.boxes,
    edges: painter.edges,
    width: size.w + PAD * 2,
    height: size.h + PAD * 2,
  }
}

// ───────────────────────────── отрисовка ─────────────────────────────

interface Props {
  nodes: RouteNode[]
  selected: RouteNode | null
  onSelect: (node: RouteNode | null) => void
}

// Длинные схемы идут в одну линию на несколько тысяч точек, поэтому «вписать»
// должно уметь уходить далеко вниз: сначала виден весь силуэт, потом зум.
const MIN_SCALE = 0.1
const MAX_SCALE = 2.5

export function RouteDiagram({ nodes, selected, onSelect }: Props) {
  const { t } = useI18n()
  const viewport = useRef<HTMLDivElement>(null)
  const layout = useMemo(() => layoutRoute(nodes), [nodes])

  const [view, setView] = useState({ x: 0, y: 0, scale: 1 })
  const [grabbing, setGrabbing] = useState(false)
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  /** Вписывает схему в окно — с этого начинается просмотр любой схемы. */
  const fit = useCallback(() => {
    const element = viewport.current
    if (!element) return
    const { clientWidth, clientHeight } = element
    const scale = Math.min(1, (clientWidth - 32) / layout.width, (clientHeight - 32) / layout.height)
    const safe = Math.max(MIN_SCALE, scale)
    setView({
      scale: safe,
      x: (clientWidth - layout.width * safe) / 2,
      y: (clientHeight - layout.height * safe) / 2,
    })
  }, [layout.width, layout.height])

  useLayoutEffect(() => { fit() }, [fit])

  // Колесо масштабирует относительно курсора, поэтому слушатель непассивный.
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const px = event.clientX - rect.left
      const py = event.clientY - rect.top
      setView((current) => {
        const factor = Math.exp(-event.deltaY * 0.0015)
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor))
        const ratio = scale / current.scale
        return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio }
      })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  const onMouseDown = useCallback((event: React.MouseEvent) => {
    // По шагам кликают, за пустое место таскают.
    if ((event.target as HTMLElement).closest('[data-step]')) return
    drag.current = { x: event.clientX, y: event.clientY, ox: view.x, oy: view.y }
    setGrabbing(true)
    onSelect(null)
  }, [view.x, view.y, onSelect])

  useEffect(() => {
    if (!grabbing) return
    const onMove = (event: MouseEvent) => {
      const start = drag.current
      if (!start) return
      setView((current) => ({
        ...current,
        x: start.ox + (event.clientX - start.x),
        y: start.oy + (event.clientY - start.y),
      }))
    }
    const onUp = () => { drag.current = null; setGrabbing(false) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [grabbing])

  const zoom = useCallback((factor: number) => {
    const element = viewport.current
    if (!element) return
    const px = element.clientWidth / 2
    const py = element.clientHeight / 2
    setView((current) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor))
      const ratio = scale / current.scale
      return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio }
    })
  }, [])

  return (
    <div
      ref={viewport}
      onMouseDown={onMouseDown}
      className={cx('relative h-full w-full overflow-hidden', grabbing ? 'cursor-grabbing' : 'cursor-grab')}
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{
          width: layout.width,
          height: layout.height,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
        }}
      >
        <svg
          width={layout.width}
          height={layout.height}
          className="pointer-events-none absolute inset-0 text-line-strong"
        >
          <defs>
            <marker id="route-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
              <path d="M0,0 L9,4.5 L0,9 z" fill="currentColor" />
            </marker>
          </defs>
          {layout.edges.map((edge) => (
            <path
              key={edge.key}
              d={edge.d}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              markerEnd="url(#route-arrow)"
            />
          ))}
        </svg>

        {layout.boxes.map((box) => (
          <BoxView
            key={box.key}
            box={box}
            selected={box.node !== null && box.node === selected}
            onSelect={onSelect}
            t={t}
          />
        ))}
      </div>

      <div className="absolute bottom-4 left-4 flex items-center gap-1 rounded-xl border border-line bg-surface/90 px-1.5 py-1 backdrop-blur">
        <ToolButton label="−" title={t('route.zoomOut')} onClick={() => zoom(1 / 1.2)} />
        <button
          type="button"
          onClick={fit}
          title={t('route.fit')}
          className="rounded-md px-2 py-1 font-mono text-[11px] text-content-subtle transition hover:bg-surface-3 hover:text-content"
        >
          {Math.round(view.scale * 100)}%
        </button>
        <ToolButton label="+" title={t('route.zoomIn')} onClick={() => zoom(1.2)} />
      </div>

      <p className="pointer-events-none absolute bottom-4 right-4 text-[10.5px] text-content-subtle">
        {t('route.panHint')}
      </p>
    </div>
  )
}

function ToolButton({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="grid size-6 place-items-center rounded-md text-[13px] text-content-muted transition hover:bg-surface-3 hover:text-content"
    >
      {label}
    </button>
  )
}

const TONE_BORDER: Record<Box['tone'], string> = {
  plain: 'border-line-strong bg-surface',
  entry: 'border-positive/50 bg-positive/10',
  send: 'border-accent/50 bg-accent/10',
  branch: 'border-caution/50 bg-caution/10',
  error: 'border-negative/45 bg-negative/10',
}

function BoxView({ box, selected, onSelect, t }: {
  box: Box
  selected: boolean
  onSelect: (node: RouteNode | null) => void
  t: Translate
}) {
  const style = { left: box.x, top: box.y, width: box.w, height: box.h } as const
  const node = box.node

  if (box.shape === 'stub') {
    return (
      <div
        style={style}
        className="absolute grid place-items-center rounded-lg border border-dashed border-line-strong text-[10.5px] text-content-subtle"
      >
        {t('route.emptyBranch')}
      </div>
    )
  }

  if (box.shape === 'group' && node) {
    return (
      <div
        style={style}
        className={cx(
          'absolute rounded-2xl border-2 border-dashed',
          box.tone === 'error' ? 'border-negative/35 bg-negative/4' : 'border-line-strong bg-surface-2/30',
        )}
      >
        <button
          type="button"
          data-step
          onClick={() => onSelect(node)}
          style={{ maxWidth: box.w - 24 }}
          className={cx(
            'absolute left-3 top-2 flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] transition',
            selected ? 'bg-accent/20 text-accent-content' : 'text-content-muted hover:bg-surface-3',
          )}
        >
          <span className="shrink-0">{ICONS[node.kind] ?? '▪'}</span>
          <span className="shrink-0 whitespace-nowrap font-medium">
            {box.frameLabel === node.kind ? kindLabel(node.kind, t) : box.frameLabel}
          </span>
          {node.exceptions.length > 0 && (
            <span className="min-w-0 truncate font-mono text-[10px] text-content-subtle">
              {node.exceptions.join(', ')}
            </span>
          )}
        </button>
      </div>
    )
  }

  if (!node) return null

  if (box.shape === 'start' || box.shape === 'end') {
    return (
      <button
        type="button"
        data-step
        onClick={() => onSelect(node)}
        style={style}
        className={cx(
          'absolute grid place-items-center rounded-full border-2 text-[16px] transition',
          TONE_BORDER[box.tone],
          box.shape === 'end' && 'border-[3px]',
          selected ? 'ring-2 ring-accent ring-offset-2 ring-offset-canvas' : 'hover:border-content-subtle',
        )}
        title={node.label ?? kindLabel(node.kind, t)}
      >
        <span>{ICONS[node.kind] ?? '▪'}</span>
        <span
          className="pointer-events-none absolute left-1/2 top-full mt-1 w-44 -translate-x-1/2 truncate text-center text-[11px] font-medium text-content"
        >
          {node.label ?? kindLabel(node.kind, t)}
        </span>
      </button>
    )
  }

  if (box.shape === 'gateway') {
    return (
      <button
        type="button"
        data-step
        onClick={() => onSelect(node)}
        style={style}
        title={node.label ?? kindLabel(node.kind, t)}
        className="absolute grid place-items-center"
      >
        <span
          className={cx(
            'grid size-[38px] rotate-45 place-items-center rounded-[6px] border-2 transition',
            TONE_BORDER.branch,
            selected ? 'ring-2 ring-accent' : 'hover:border-content-subtle',
          )}
        >
          <span className="-rotate-45 text-[13px]">{ICONS[node.kind] ?? '◈'}</span>
        </span>
      </button>
    )
  }

  if (box.shape === 'branch') {
    const condition = node.expression ? firstLine(node.expression.text, 40) : t('route.anyMessage')
    return (
      <button
        type="button"
        data-step
        onClick={() => onSelect(node)}
        style={style}
        title={node.expression?.text}
        className={cx(
          'absolute flex flex-col justify-center rounded-lg border px-2.5 text-left transition',
          node.kind === 'otherwise' ? 'border-line-strong bg-surface' : TONE_BORDER.branch,
          selected ? 'ring-2 ring-accent' : 'hover:border-content-subtle',
        )}
      >
        <span className="text-[9.5px] uppercase tracking-wide text-content-subtle">{kindLabel(node.kind, t)}</span>
        <span className="truncate font-mono text-[11px] text-content">{condition}</span>
      </button>
    )
  }

  const adapter = node.uri ? scheme(node.uri) : null
  const note = summary(node)

  return (
    <button
      type="button"
      data-step
      onClick={() => onSelect(node)}
      style={style}
      title={node.uri ?? node.label ?? undefined}
      className={cx(
        'absolute flex flex-col gap-1 rounded-xl border px-2.5 py-2 text-left transition',
        TONE_BORDER[box.tone],
        selected ? 'ring-2 ring-accent' : 'hover:border-content-subtle',
      )}
    >
      <span className="flex items-center gap-1.5">
        <span className="grid size-5 shrink-0 place-items-center rounded bg-surface-2 text-[11px] text-content-muted">
          {ICONS[node.kind] ?? '▪'}
        </span>
        <span className="min-w-0 flex-1 truncate text-[10px] uppercase tracking-wide text-content-subtle">
          {kindLabel(node.kind, t)}
        </span>
        {adapter && (
          <span className="shrink-0 rounded bg-surface-2 px-1 font-mono text-[9.5px] text-content-subtle">{adapter}</span>
        )}
      </span>
      <span className="line-clamp-2 min-h-0 flex-1 text-[12px] font-medium leading-tight">
        {node.label ?? kindLabel(node.kind, t)}
      </span>
      {note && <span className="shrink-0 truncate font-mono text-[10px] text-content-subtle">{note}</span>}
    </button>
  )
}
