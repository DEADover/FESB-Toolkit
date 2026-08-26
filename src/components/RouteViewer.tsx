import { useCallback, useEffect, useState } from 'react'

import { useI18n } from '../i18n'
import { errorText, readRoute, revealPath } from '../lib/api'
import type { RouteGraph, RouteNode } from '../types'
import { kindLabel, RouteDiagram, shortUri } from './RouteDiagram'
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
  /** Масштаб схемы: у больших СОПС сотня шагов, целиком они в экран не входят. */
  const [scale, setScale] = useState(1)

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

        <div className="flex items-center gap-1">
          <Button size="sm" onClick={() => setScale((value) => Math.max(0.5, Math.round((value - 0.1) * 10) / 10))} aria-label={t('route.zoomOut')}>−</Button>
          <button
            type="button"
            onClick={() => setScale(1)}
            title={t('route.zoomReset')}
            className="w-12 rounded-md px-1 py-1 text-center font-mono text-[11px] text-content-subtle transition hover:bg-surface-3 hover:text-content"
          >
            {Math.round(scale * 100)}%
          </button>
          <Button size="sm" onClick={() => setScale((value) => Math.min(1.6, Math.round((value + 0.1) * 10) / 10))} aria-label={t('route.zoomIn')}>+</Button>
        </div>

        <Button onClick={() => void revealPath(path)}>{t('action.reveal')}</Button>
        <Button variant="primary" onClick={close}>{t('action.close')}</Button>
      </header>

      {graph?.description && (
        <p className="whitespace-pre-wrap border-b border-line bg-surface-2/60 px-5 py-2 text-[11.5px] leading-relaxed text-content-muted">
          {graph.description}
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          {loading && (
            <div className="flex h-full items-center justify-center gap-2 text-content-subtle">
              <Spinner className="size-5" /> {t('empty.scanning')}
            </div>
          )}
          {error && (
            <div className="m-5 rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-negative">{error}</div>
          )}
          {!loading && !error && graph && (
            // zoom, а не transform: при масштабировании должна меняться и область прокрутки.
            <div style={{ zoom: scale }}>
              <RouteDiagram nodes={graph.nodes} selected={selected} onSelect={setSelected} />
            </div>
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

function Details({ node }: { node: RouteNode }) {
  const { t } = useI18n()
  return (
    <div className="space-y-4 px-5 py-4">
      <div>
        <div className="text-[11px] tracking-wide text-content-subtle">{kindLabel(node.kind, t)}</div>
        <div className="text-[14px] font-semibold">{node.label ?? kindLabel(node.kind, t)}</div>
        {node.component && (
          <div className="mt-0.5 font-mono text-[11px] text-content-subtle">{node.component}</div>
        )}
      </div>

      {node.uri && (
        <Block label={t('route.uri')}>
          <code className="block break-all font-mono text-[11.5px] text-content-muted">{node.uri}</code>
        </Block>
      )}

      {node.expression && (
        <Block label={t('route.expression', { language: node.expression.language })}>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-2 px-3 py-2 font-mono text-[11px] leading-relaxed text-content-muted">
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

      {node.format && (
        <Block label={t('route.format')}>
          <code className="font-mono text-[11.5px] text-content-muted">{node.format}</code>
        </Block>
      )}

      {node.exceptions.length > 0 && (
        <Block label={t('route.exceptions')}>
          <div className="flex flex-col gap-1">
            {node.exceptions.map((item) => (
              <code key={item} className="break-all font-mono text-[11.5px] text-negative">{item}</code>
            ))}
          </div>
        </Block>
      )}

      {node.attributes.length > 0 && (
        <Block label={t('route.attributes')}>
          <dl className="flex flex-col gap-1.5">
            {node.attributes.map((attribute) => (
              <div key={attribute.name} className="min-w-0">
                <dt className="text-[10.5px] text-content-subtle">{attribute.name}</dt>
                <dd className="break-all font-mono text-[11.5px] text-content-muted">{attribute.value || '—'}</dd>
              </div>
            ))}
          </dl>
        </Block>
      )}

      <div className="text-[10.5px] text-content-subtle">{t('table.line')}: {node.line}</div>
    </div>
  )
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={cx('min-w-0')}>
      <div className="mb-1 text-[11px] tracking-wide text-content-subtle">{label}</div>
      {children}
    </div>
  )
}

/** Короткий адрес используется и в подсказках списка СОПС. */
export { shortUri }
