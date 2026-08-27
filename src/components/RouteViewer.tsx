import { useCallback, useEffect, useState, type ReactNode} from 'react'

import { ArrowElbowUpRight, ArrowLineDown, ArrowLineRight, ArrowRight, ArrowsClockwise, ArrowsLeftRight, ArrowsMerge, ArrowsSplit, Backspace, Circle, Database, Diamond, Function as FunctionIcon, Funnel, Gear, NotePencil, Play, PlusSquare, ShareNetwork, ShieldCheck, Stop, Warning, XCircle, type Icon } from '@phosphor-icons/react'

import { useI18n } from '../i18n'
import { errorText, readRoute, revealPath } from '../lib/api'
import type { RouteGraph, RouteNeighbours, RouteNode, RouteState } from '../types'
import { byUri } from '../lib/links'
import { kindLabel, RouteDiagram, scheme, shortUri } from './RouteDiagram'
import { Badge, Button, cx, DataTable, Notice, Spinner, Th, THead } from './ui'

interface Props {
  /** Путь к файлу СОПС; `null` — просмотрщик закрыт. */
  path: string | null
  domainName: string | null
  /** На macOS шапку нужно опустить под кнопки окна. */
  isMac: boolean
  /** Живые счётчики с сервера — если схема открыта из раздела API. */
  live?: RouteState | null
  /** Кто вызывает эту схему и кого вызывает она. */
  links?: RouteNeighbours | null
  /** Переход к соседней схеме по связи. */
  onOpenRoute?: (path: string) => void
  onClose: () => void
}

/**
 * Полноэкранный просмотр схемы СОПС.
 *
 * Схема легко уходит и вширь, и вниз, поэтому это не диалог, а отдельный слой
 * во весь экран: под диаграмму отдаётся всё место, а подробности выбранного
 * шага живут в боковой панели, не загромождая карточки.
 */
export function RouteViewer({ path, domainName, isMac, live, links, onOpenRoute, onClose }: Props) {
  const { t } = useI18n()
  const [graphs, setGraphs] = useState<RouteGraph[] | null>(null)
  const [current, setCurrent] = useState(0)
  const [selected, setSelected] = useState<RouteNode | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!path) {
      setGraphs(null)
      setSelected(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setSelected(null)
    setCurrent(0)
    readRoute(path)
      .then((result) => { if (!cancelled) setGraphs(result) })
      .catch((err) => { if (!cancelled) { setError(errorText(err)); setGraphs(null) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [path])

  const close = useCallback(() => onClose(), [onClose])

  useEffect(() => {
    if (!path) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [path, close])

  if (!path) return null
  const graph = graphs?.[current] ?? null

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-canvas">
      <header
        data-tauri-drag-region
        className={cx('flex items-center gap-3 border-b border-line bg-surface px-5', isMac ? 'pb-3 pt-9' : 'py-3')}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold">
              {graph?.name ?? t('routes.unknownName')}
            </h2>
            {graph && (
              <Badge tone={graph.traceEnabled ? 'ok' : 'neutral'}>
                {graph.traceEnabled ? t('routes.trace.on') : t('routes.trace.off')}
              </Badge>
            )}
            {graph?.traceConfig && (
              <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-content-muted">
                {graph.traceConfig}
              </code>
            )}
            {graph && <span className="text-[11.5px] text-content-subtle">{t('route.steps', { count: graph.steps })}</span>}
          </div>
          <p className="truncate text-[11.5px] text-content-subtle">
            {domainName ? `${domainName} · ` : ''}{graph?.id ?? path}
          </p>
        </div>

        {graphs && graphs.length > 1 && (
          <div className="flex items-center gap-1">
            {graphs.map((item, index) => (
              <Button
                key={item.id ?? index}
                size="sm"
                variant={index === current ? 'primary' : 'secondary'}
                onClick={() => { setCurrent(index); setSelected(null) }}
              >
                {item.name ?? `#${index + 1}`}
              </Button>
            ))}
          </div>
        )}

        <Button onClick={() => void revealPath(path)}>{t('action.reveal')}</Button>
        <Button variant="primary" onClick={close}>{t('action.close')}</Button>
      </header>

      {live && <LiveStrip live={live} />}

      {graph?.description && (
        <p className="whitespace-pre-wrap border-b border-line bg-surface-2/60 px-5 py-2 text-[11.5px] leading-relaxed text-content-muted">
          {graph.description}
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1">
          {loading && (
            <div className="flex h-full items-center justify-center gap-2 text-content-subtle">
              <Spinner className="size-5" /> {t('empty.scanning')}
            </div>
          )}
          {error && (
            <Notice tone="danger" className="m-5">{error}</Notice>
          )}
          {!loading && !error && graph && (
            <RouteDiagram
              nodes={graph.nodes}
              selected={selected}
              onSelect={setSelected}
              outgoing={links ? byUri(links.outgoing) : undefined}
              incoming={links?.incoming}
              onOpenRoute={onOpenRoute}
            />
          )}
          {!loading && !error && graphs?.length === 0 && (
            <div className="flex h-full items-center justify-center text-content-subtle">{t('route.noGraph')}</div>
          )}
        </div>

        <aside className="flex w-96 shrink-0 flex-col overflow-y-auto border-l border-line bg-surface">
          {links && onOpenRoute && <Links links={links} onOpen={onOpenRoute} />}
          {selected ? <Details node={selected} /> : (
            <p className="px-5 py-6 text-[11.5px] leading-relaxed text-content-subtle">{t('route.pickStep')}</p>
          )}
        </aside>
      </div>
    </div>
  )
}

/**
 * Полоса живого состояния: чем маршрут занят прямо сейчас.
 *
 * Счётчики у шины — на маршрут целиком, а не на шаг, поэтому им место
 * в шапке, а не на карточках схемы.
 */
function LiveStrip({ live }: { live: RouteState }) {
  const { t } = useI18n()
  const started = live.state === 'Started'
  return (
    <div className="flex items-center gap-6 border-b border-line bg-surface-2/60 px-5 py-2">
      <span className="flex items-center gap-2">
        <span className={cx('size-2 rounded-full', started ? 'bg-positive' : 'bg-content-subtle/50')} />
        <span className="text-[12px] font-medium">{live.state ?? '—'}</span>
      </span>
      <Metric label={t('routes.processed')} value={live.processed.toLocaleString()} />
      <Metric label={t('map.errors')} value={live.failed.toLocaleString()} tone={live.failed > 0 ? 'danger' : undefined} />
      <Metric label={t('routes.handled')} value={live.failuresHandled.toLocaleString()} />
      <Metric label={t('map.inflight')} value={live.inflight.toLocaleString()} tone={live.inflight > 0 ? 'warn' : undefined} />
      <Metric label={t('routes.time')} value={`${live.minMs} / ${live.meanMs} / ${live.maxMs} ${t('routes.ms')}`} />
      {live.lastProcessed && <Metric label={t('routes.last')} value={live.lastProcessed.replace('T', ' ').slice(0, 19)} />}
      {!live.autoStartup && (
        <Badge tone="warn" className="ml-auto">
          {t('routes.noAutoStart')}
        </Badge>
      )}
    </div>
  )
}

/**
 * Показатель в живой полосе над схемой.
 *
 * Не `Readout`: здесь моноширинный шрифт и компактный кегль, потому что
 * значения меняются на глазах и не должны дёргать соседей по ширине.
 */
function Metric({ label, value, tone }: { label: string; value: string; tone?: 'danger' | 'warn' }) {
  return (
    <span className="min-w-0">
      <span className="block text-[10px] uppercase tracking-wide text-content-subtle">{label}</span>
      <span className={cx(
        'block truncate font-mono text-[11.5px] tabular-nums',
        tone === 'danger' ? 'text-negative' : tone === 'warn' ? 'text-caution' : 'text-content',
      )}>
        {value}
      </span>
    </span>
  )
}

/**
 * Связи схемы с другими.
 *
 * Маршруты соединяются адресом: один пишет в `direct://Name`, другой этим же
 * адресом начинается. Без этой панели такую цепочку приходится искать
 * поиском по всей выгрузке.
 */
function Links({ links, onOpen }: { links: RouteNeighbours; onOpen: (path: string) => void }) {
  const { t } = useI18n()
  if (links.incoming.length === 0 && links.outgoing.length === 0) {
    return (
      <div className="border-b border-line px-5 py-3 text-[11.5px] text-content-subtle">
        {t('links.none')}
      </div>
    )
  }

  return (
    <div className="border-b border-line">
      <Side
        label={t('links.incoming', { count: links.incoming.length })}
        items={links.incoming}
        onOpen={onOpen}
        arrow={<ArrowRight size={11} weight="bold" />}
      />
      <Side
        label={t('links.outgoing', { count: links.outgoing.length })}
        items={links.outgoing}
        onOpen={onOpen}
        arrow={<ArrowRight size={11} weight="bold" />}
      />
    </div>
  )
}

function Side({ label, items, onOpen, arrow }: {
  label: string
  items: RouteNeighbours['incoming']
  onOpen: (path: string) => void
  arrow: ReactNode
}) {
  const { t } = useI18n()
  if (items.length === 0) return null
  return (
    <div className="px-5 py-3">
      <div className="mb-1.5 text-[10px] uppercase tracking-wide text-content-subtle">{label}</div>
      <div className="flex flex-col gap-1">
        {items.map((item) => (
          <button
            key={`${item.path}-${item.uri}`}
            type="button"
            onClick={() => onOpen(item.path)}
            title={t('links.open', { uri: item.uri })}
            className="flex items-center gap-2 rounded-lg border border-line-strong bg-surface-2/50 px-2.5 py-1.5 text-left transition hover:border-content-subtle hover:bg-surface-3"
          >
            <span className="shrink-0 text-[10px] text-content-subtle">{arrow}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px]">{item.name ?? t('routes.unknownName')}</span>
              <span className="block truncate font-mono text-[10px] text-content-subtle">
                {item.domain} · {item.uri}
              </span>
            </span>
            <span className={cx(
              'shrink-0 rounded px-1 text-[9.5px]',
              item.kind === 'call' ? 'bg-accent/15 text-accent-content' : 'bg-surface-3 text-content-subtle',
            )}>
              {item.kind === 'call' ? t('links.call') : t('links.queue')}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** Подробности шага: сводка таблицей, длинные тексты — блоками под ней. */
function Details({ node }: { node: RouteNode }) {
  const { t } = useI18n()
  const adapter = node.uri ? scheme(node.uri) : null

  const rows: Array<{ label: string; value: string; mono?: boolean }> = []
  rows.push({ label: t('route.row.kind'), value: kindLabel(node.kind, t) })
  if (node.component) rows.push({ label: t('route.row.component'), value: node.component, mono: true })
  if (adapter) rows.push({ label: t('route.row.adapter'), value: adapter, mono: true })
  if (node.format) rows.push({ label: t('route.format'), value: node.format, mono: true })
  for (const exception of node.exceptions) {
    rows.push({ label: t('route.row.exception'), value: exception, mono: true })
  }
  const assignments = node.assignments ?? []
  for (const attribute of node.attributes) {
    // У склеенного компонента `name` — это имя первой строки таблицы,
    // а не свойство шага: показывать его отдельно было бы враньём.
    if (assignments.length > 0 && attribute.name === 'name') continue
    rows.push({ label: attribute.name, value: attribute.value || '—', mono: true })
  }
  if (assignments.length > 0) rows.push({ label: t('route.row.assignments'), value: String(assignments.length) })

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-line-strong bg-surface-2 text-[17px] text-content-muted">
          <StepIcon kind={node.kind} />
        </span>
        <span className="min-w-0 pt-0.5">
          <span className="block text-[10px] uppercase tracking-wide text-content-subtle">
            {kindLabel(node.kind, t)}
          </span>
          <span className="block break-words text-[15px] font-semibold leading-tight">
            {node.label ?? kindLabel(node.kind, t)}
          </span>
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-line">
        <DataTable dense>
          <colgroup>
            <col className="w-[108px]" />
            <col />
          </colgroup>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.label}-${index}`} className="border-b border-line last:border-b-0 align-top">
                <td className="border-r border-line bg-surface-2/70 px-3 py-2 font-medium text-content-subtle">
                  <span className="block break-words">{row.label}</span>
                </td>
                <td className={cx('px-3 py-2 text-content-muted', row.mono ? 'break-all font-mono text-[11px]' : 'break-words')}>
                  {row.value}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </div>

      {/*
        Таблица присвоений — так же, как в редакторе FESB: имя, язык, выражение.
        Один блок «Установить переменные» задаёт их пачкой, и читать их надо
        вместе, а не как десяток одинаковых шагов на схеме.
      */}
      {assignments.length > 0 && (
        <Block label={t('route.assignments', { count: assignments.length })}>
          <div className="overflow-hidden rounded-lg border border-line">
            <DataTable dense>
              {/* Панель узкая: имени и синтаксиса хватает малого, выражению нужен остаток. */}
              <colgroup>
                <col className="w-28" />
                <col className="w-14" />
                <col />
              </colgroup>
              <THead>
                <Th className="px-2 py-1.5">{t('route.assign.name')}</Th>
                <Th className="px-2 py-1.5">{t('route.assign.language')}</Th>
                <Th className="px-2 py-1.5">{t('route.assign.value')}</Th>
              </THead>
              <tbody>
                {assignments.map((item, index) => (
                  <tr key={`${item.name}-${index}`} className="border-b border-line/60 align-top last:border-b-0">
                    <td className="break-all px-2 py-1.5 font-mono text-[11px] text-content">{item.name || '—'}</td>
                    <td className="px-2 py-1.5 font-mono text-[10px] uppercase text-content-subtle">
                      {item.language ?? '—'}
                    </td>
                    <td className="break-all px-2 py-1.5 font-mono text-[11px] text-content-muted">
                      {item.value || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        </Block>
      )}

      {node.uri && (
        <Block label={t('route.uri')}>
          <code className="block break-all font-mono text-[11px] leading-relaxed text-content-muted">{node.uri}</code>
        </Block>
      )}

      {node.expression && assignments.length === 0 && (
        <Block label={t('route.expression', { language: node.expression.language })}>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-content-muted">
            {node.expression.text}
          </pre>
        </Block>
      )}

      {node.description && (
        <Block label={t('table.description')}>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-content-muted">
            {node.description}
          </pre>
        </Block>
      )}
    </div>
  )
}

/** Те же значки, что и на схеме: панель должна узнаваться с одного взгляда. */
const STEP_ICONS: Record<string, Icon> = {
  from: Play, to: ArrowRight, toD: ArrowRight, log: NotePencil,
  setHeader: PlusSquare, setProperty: PlusSquare, setBody: PlusSquare,
  removeHeaders: Backspace, removeHeader: Backspace, removeProperties: Backspace,
  transform: FunctionIcon, bean: Gear, process: Gear,
  marshal: ArrowsLeftRight, unmarshal: ArrowsLeftRight, convertBodyTo: ArrowsLeftRight,
  choice: Diamond, when: Diamond, otherwise: Diamond, filter: Funnel,
  split: ArrowsSplit, loop: ArrowsClockwise,
  doTry: ShieldCheck, doCatch: Warning, doFinally: ArrowLineDown, onException: Warning,
  throwException: XCircle, stop: Stop,
  wireTap: ArrowElbowUpRight, recipientList: ShareNetwork,
  pollEnrich: ArrowLineRight, enrich: ArrowLineRight,
  aggregate: ArrowsMerge, transacted: Database,
}

/** Шаг, которого нет в списке, рисуется точкой — лучше, чем пустое место. */
function StepIcon({ kind, size = 12 }: { kind: string; size?: number }) {
  const Glyph = STEP_ICONS[kind] ?? Circle
  return <Glyph size={size} weight="bold" />
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <div className="border-b border-line bg-surface-2/70 px-3 py-1.5 text-[10px] uppercase tracking-wide text-content-subtle">
        {label}
      </div>
      <div className="px-3 py-2">{children}</div>
    </div>
  )
}

/** Короткий адрес используется и в подсказках списка СОПС. */
export { shortUri }
