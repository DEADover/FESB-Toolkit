import { useMemo } from 'react'

import { ArrowRight, Check } from '@phosphor-icons/react'

import { useI18n, type MessageKey } from '../i18n'
import { revealPath } from '../lib/api'
import { routeSummary, routesUsingBean } from '../lib/rows'
import type { ApplyReport, DomainRecord, ScanResult } from '../types'
import { Badge, Button, cx, Modal, Spinner, Stat, Th } from './ui'

interface Props {
  report: ApplyReport | null
  /** Нужен, чтобы показать в отчёте, скольких СОПС коснулось изменение. */
  scan: ScanResult | null
  archiving: boolean
  onBuildArchive: () => void
  onClose: () => void
}

export function ReportDialog({ report, scan, archiving, onBuildArchive, onClose }: Props) {
  const { t } = useI18n()

  // Отчёт приходит от бэкенда без данных о маршрутах — берём их из последнего сканирования.
  const domainsByPath = useMemo(() => {
    const map = new Map<string, DomainRecord>()
    for (const domain of scan?.domains ?? []) map.set(domain.domainXmlPath, domain)
    return map
  }, [scan])

  if (!report) return null
  const { summary, results } = report

  return (
    <Modal
      open
      wide
      onClose={onClose}
      closeLabel={t('action.close')}
      title={summary.dryRun ? t('report.titleDry') : t('report.title')}
      footer={
        <>
          {!summary.dryRun && summary.ok > 0 && (
            <Button onClick={onBuildArchive} disabled={archiving}>
              {archiving ? <><Spinner className="size-4" /> {t('zip.building')}</> : t('action.buildZip')}
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>{t('action.close')}</Button>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-8 rounded-xl border border-line bg-surface-2 px-5 py-4">
        <Stat label={t('report.processed')} value={summary.total} />
        <Stat label={t('report.filesChanged')} value={summary.ok} tone="accent" />
        <Stat label={t('report.valuesChanged')} value={summary.valuesChanged} tone="accent" />
        <Stat label={t('report.skipped')} value={summary.skipped} tone={summary.skipped ? 'warn' : undefined} />
        <Stat label={t('report.failed')} value={summary.failed} tone={summary.failed ? 'danger' : undefined} />
        <div className="ml-auto text-right">
          <div className="text-[11px] tracking-wide text-content-subtle">{t('report.newValues')}</div>
          {summary.broker && <NewValue label={t('table.broker')} value={summary.broker} />}
          {summary.queue && <NewValue label={t('table.queue')} value={summary.queue} />}
          {summary.traceMode && <NewValue label={t('table.traceMode')} value={summary.traceMode} />}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-line">
        {/* Своя оболочка, не `DataTable`: см. TraceTable — та же причина. */}
        <table className="w-full border-separate border-spacing-0 text-[12.5px]">
          <thead>
            <tr className="bg-surface-2 text-left text-[11.5px] text-content-subtle">
              <Th className="w-64 border-b border-line">{t('table.domain')}</Th>
              <Th className="w-24 border-b border-line">{t('report.status')}</Th>
              <Th className="border-b border-line">{t('report.details')}</Th>
              <Th className="w-24 border-b border-line">{t('table.routes')}</Th>
              <Th className="w-20 border-b border-line text-center">{t('report.backup')}</Th>
            </tr>
            </thead>
          <tbody>
            {results.map((result) => {
              const domain = domainsByPath.get(result.domainXmlPath)
              const routes = domain ? routeSummary(domain) : null
              return (
                <tr key={result.domainXmlPath} className="align-top">
                  <td className="border-b border-line px-3 py-2">
                    <button
                      type="button"
                      onClick={() => revealPath(result.domainXmlPath)}
                      className="text-left font-medium hover:text-accent-content"
                      title={t('report.openFile', { path: result.domainXmlPath })}
                    >
                      {result.domainName}
                    </button>
                  </td>

                  <td className="border-b border-line px-3 py-2">
                    <Badge tone={result.status === 'ok' ? 'ok' : result.status === 'skipped' ? 'warn' : 'danger'}>
                      {t(`report.status.${result.status}` as MessageKey)}
                    </Badge>
                  </td>

                  <td className="border-b border-line px-3 py-2">
                    {result.error && <div className="text-negative">{result.error}</div>}
                    {result.changed.map((change) => (
                      <div key={change.beanId ?? change.beanName} className="mb-1 last:mb-0">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="font-mono text-[11.5px] text-content-muted">{change.beanId}</span>
                          {domain && (
                            <span className="text-[10.5px] text-content-subtle" title={t('table.usedByHint')}>
                              {t('table.usedBy').toLowerCase()} {routesUsingBean(domain, change.beanId)}
                            </span>
                          )}
                        </div>
                        {change.fields.map((field) => (
                          <div key={field.field} className="flex flex-wrap items-center gap-1.5 pl-3 font-mono text-[11.5px]">
                            <span className="text-content-subtle">{field.field}</span>
                            <span className="text-content-subtle line-through">{field.from}</span>
                            <span className="inline-flex items-center gap-1 text-accent-content"><ArrowRight size={11} weight="bold" /> {field.to}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                    {result.skipped.map((skip, index) => (
                      <div key={`${skip.beanId}-${skip.field}-${index}`} className="text-[11.5px] text-caution">
                        <span className="font-mono">{skip.beanId ?? '—'}</span>
                        {skip.field ? ` · ${skip.field}` : ''}: {t(`skip.${skip.reason}` as MessageKey)}
                        {skip.actual ? ` (${skip.actual})` : ''}
                      </div>
                    ))}
                  </td>

                  <td className="border-b border-line px-3 py-2">
                    {routes && routes.total > 0 ? (
                      <span
                        className="whitespace-nowrap font-mono text-[11.5px] tabular-nums"
                        title={t('table.routesHint', { traced: routes.traced, total: routes.total })}
                      >
                        <span className={routes.traced > 0 ? 'text-accent-content' : 'text-content-subtle'}>{routes.traced}</span>
                        <span className="text-content-subtle"> / {routes.total}</span>
                      </span>
                    ) : (
                      <span className="text-content-subtle">—</span>
                    )}
                  </td>

                  <td className="border-b border-line px-3 py-2 text-center">
                    <span
                      className={cx('text-[13px]', result.backupPath ? 'text-positive' : 'text-content-subtle')}
                      title={result.backupPath
                        ? t('report.backupDone', { name: result.backupPath.split(/[/\\]/).pop() ?? '' })
                        : t('report.backupNone')}
                    >
                      {result.backupPath ? <Check size={13} weight="bold" className="inline text-positive" /> : '—'}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}

function NewValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="font-mono text-[12.5px] text-accent-content">
      <span className="text-content-subtle">{label}: </span>{value}
    </div>
  )
}
