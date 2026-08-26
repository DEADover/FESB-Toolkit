import { useCallback, useEffect, useState } from 'react'

import { useI18n } from '../i18n'
import { errorText, readRoute, revealPath } from '../lib/api'
import type { RouteGraph, RouteNode } from '../types'
import { kindLabel, RouteDiagram, scheme, shortUri } from './RouteDiagram'
import { Badge, Button, Spinner, cx } from './ui'

interface Props {
  /** Путь к файлу СОПС; `null` — просмотрщик закрыт. */
  path: string | null
  domainName: string | null
  onClose: () => void
}

/**
 * Полноэкранный просмотр схемы СОПС.
 *
 * Схема легко уходит и вширь, и вниз, поэтому это не диалог, а отдельный слой
 * во весь экран: под диаграмму отдаётся всё место, а подробности выбранного
 * шага живут в боковой панели, не загромождая карточки.
 */
export function RouteViewer({ path, domainName, onClose }: Props) {
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
      <header className="flex items-center gap-3 border-b border-line bg-surface px-5 py-3">
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
            <div className="m-5 rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-negative">{error}</div>
          )}
          {!loading && !error && graph && (
            <RouteDiagram nodes={graph.nodes} selected={selected} onSelect={setSelected} />
          )}
          {!loading && !error && graphs?.length === 0 && (
            <div className="flex h-full items-center justify-center text-content-subtle">{t('route.noGraph')}</div>
          )}
        </div>

        <aside className="w-96 shrink-0 overflow-y-auto border-l border-line bg-surface">
          {selected ? <Details node={selected} /> : (
            <p className="px-5 py-6 text-[11.5px] leading-relaxed text-content-subtle">{t('route.pickStep')}</p>
          )}
        </aside>
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
  for (const attribute of node.attributes) {
    rows.push({ label: attribute.name, value: attribute.value || '—', mono: true })
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-3 border-b border-line px-5 py-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-[16px] text-content-muted">
          {STEP_ICON[node.kind] ?? '▪'}
        </span>
        <span className="min-w-0">
          <span className="block text-[10.5px] uppercase tracking-wide text-content-subtle">
            {kindLabel(node.kind, t)}
          </span>
          <span className="block text-[14px] font-semibold leading-tight">
            {node.label ?? kindLabel(node.kind, t)}
          </span>
        </span>
      </div>

      <table className="w-full table-fixed border-collapse text-[11.5px]">
        <colgroup>
          <col className="w-28" />
          <col />
        </colgroup>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.label}-${index}`} className="border-b border-line/60 align-top odd:bg-surface-2/40">
              <td className="px-5 py-1.5 text-content-subtle">{row.label}</td>
              <td className={cx('break-all py-1.5 pr-5 text-content-muted', row.mono && 'font-mono text-[11px]')}>
                {row.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {node.uri && (
        <Block label={t('route.uri')}>
          <code className="block break-all rounded-lg bg-surface-2 px-3 py-2 font-mono text-[11px] leading-relaxed text-content-muted">
            {node.uri}
          </code>
        </Block>
      )}

      {node.expression && (
        <Block label={t('route.expression', { language: node.expression.language })}>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-2 px-3 py-2 font-mono text-[11px] leading-relaxed text-content-muted">
            {node.expression.text}
          </pre>
        </Block>
      )}

      {node.description && (
        <Block label={t('table.description')}>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-2 px-3 py-2 font-mono text-[11px] leading-relaxed text-content-muted">
            {node.description}
          </pre>
        </Block>
      )}
    </div>
  )
}

/** Те же значки, что и на схеме: панель должна узнаваться с одного взгляда. */
const STEP_ICON: Record<string, string> = {
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

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-line px-5 py-3">
      <div className="mb-1.5 text-[10.5px] uppercase tracking-wide text-content-subtle">{label}</div>
      {children}
    </div>
  )
}

/** Короткий адрес используется и в подсказках списка СОПС. */
export { shortUri }
