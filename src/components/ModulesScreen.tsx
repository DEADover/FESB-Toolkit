import { useCallback, useState } from 'react'

import { useI18n } from '../i18n'
import {
  apiCreateSavePoint, apiDeleteSavePoint, apiModuleAction, apiModules, apiRollbackSavePoint,
  apiSavePoints, errorText,
} from '../lib/api'
import type { Connection, ModuleAction, ModuleRow, SavePoint, ServerInfo } from '../types'
import { ErrorBar, NotConnected, Panel, TableMessage, useApiData } from './ApiShell'
import { Badge, Button, Modal, Spinner, cx } from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  onGoToConnection: () => void
}

/**
 * Модули шины: кто работает, кто ждёт перезапуска и что с этим сделать.
 *
 * Перезапуск `factor-broker` нужен после каждой заливки конфигурации мимо
 * приложения — иначе брокер продолжает работать со старым списком доменов.
 */
export function ModulesScreen({ connection, server, onGoToConnection }: Props) {
  const { t } = useI18n()
  const load = useCallback((connection: Connection) => apiModules(connection), [])
  const { data, loading, error, reload, setError } = useApiData<ModuleRow[]>(connection, load)

  const [pending, setPending] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ module: ModuleRow; action: ModuleAction } | null>(null)

  const run = useCallback(async (module: ModuleRow, action: ModuleAction) => {
    if (!connection) return
    setConfirm(null)
    setPending(`${module.name}:${action}`)
    setError(null)
    try {
      await apiModuleAction(connection, module.name, action)
      await reload()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setPending(null)
    }
  }, [connection, reload, setError])

  /** Запуск безобиден, а остановка и перезапуск рвут обработку — спрашиваем. */
  const start = useCallback((module: ModuleRow, action: ModuleAction) => {
    if (action === 'start') void run(module, action)
    else setConfirm({ module, action })
  }, [run])

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  const modules = data ?? []
  const running = modules.filter((module) => module.running).length

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pb-4">
      <div className="flex items-center gap-3">
        <span className="text-[11.5px] text-content-subtle">
          {t('api.modules', { running, total: modules.length })}
        </span>
        {modules.some((module) => module.awaitRestart) && (
          <Badge tone="warn">{t('modules.awaitRestartHint')}</Badge>
        )}
        <Button className="ml-auto" onClick={() => void reload()} disabled={loading || pending !== null}>
          {loading ? <Spinner className="size-4" /> : '↻'} {t('action.refresh')}
        </Button>
      </div>

      <ErrorBar error={error} />

      <Panel className="shrink-0">
        <table className="w-full table-fixed border-collapse text-[12.5px]">
          <colgroup>
            <col />
            <col className="w-56" />
            <col className="w-44" />
            <col className="w-64" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-surface-2 text-[11px] tracking-wide text-content-subtle">
            <tr className="border-b border-line">
              <th className="px-3 py-2 text-left font-medium">{t('modules.module')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('modules.dependencies')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('table.state')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('modules.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {modules.map((module) => (
              <tr key={module.name} className={cx('border-b border-line/60', !module.active && 'text-content-subtle')}>
                <td className="px-3 py-2">
                  <div className="truncate font-medium" title={module.label}>{module.label}</div>
                  <div className="truncate font-mono text-[11px] text-content-subtle">{module.name}</div>
                </td>
                <td className="truncate px-3 py-2 font-mono text-[11px] text-content-subtle" title={module.dependencies.join(', ')}>
                  {module.dependencies.length > 0 ? module.dependencies.join(', ') : '—'}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-1">
                    {module.running
                      ? <Badge tone="ok">{t('modules.running')}</Badge>
                      : <Badge>{t('table.stopped')}</Badge>}
                    {!module.active && <Badge title={t('modules.inactiveHint')}>{t('modules.inactive')}</Badge>}
                    {module.warning && <Badge tone="warn">{t('modules.warning')}</Badge>}
                    {module.awaitRestart && <Badge tone="warn">{t('modules.awaitRestart')}</Badge>}
                    {module.awaitSystemRestart && <Badge tone="danger">{t('modules.awaitSystemRestart')}</Badge>}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <Action
                      label={t('modules.start')}
                      busy={pending === `${module.name}:start`}
                      disabled={pending !== null || module.running}
                      onClick={() => start(module, 'start')}
                    />
                    <Action
                      label={t('modules.stop')}
                      busy={pending === `${module.name}:stop`}
                      disabled={pending !== null || !module.running}
                      onClick={() => start(module, 'stop')}
                    />
                    <Action
                      label={t('modules.restart')}
                      busy={pending === `${module.name}:restart`}
                      disabled={pending !== null || !module.running}
                      onClick={() => start(module, 'restart')}
                    />
                  </div>
                </td>
              </tr>
            ))}
            {modules.length === 0 && (
              <TableMessage colSpan={4}>{loading ? t('empty.scanning') : t('table.empty')}</TableMessage>
            )}
          </tbody>
        </table>
      </Panel>

      <SavePoints connection={connection} />

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        closeLabel={t('action.close')}
        title={confirm?.action === 'stop' ? t('modules.confirm.stop') : t('modules.confirm.restart')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>{t('action.cancel')}</Button>
            <Button variant="primary" onClick={() => confirm && void run(confirm.module, confirm.action)}>
              {confirm?.action === 'stop' ? t('modules.stop') : t('modules.restart')}
            </Button>
          </>
        }
      >
        {confirm && (
          <div className="space-y-3 text-[13px] leading-relaxed">
            <code className="block rounded bg-accent/12 px-2 py-1 font-mono text-accent-content">
              {confirm.module.label} · {confirm.module.name}
            </code>
            <p className="text-content-muted">{t('modules.confirm.text')}</p>
            {confirm.module.name === 'factor-broker' && (
              <p className="rounded-lg border border-caution/35 bg-caution/10 px-3 py-2 text-caution">
                {t('modules.confirm.broker')}
              </p>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

/**
 * Точки восстановления живут рядом с модулями: и то и другое — обслуживание
 * сервера, и обе операции одинаково крупные по последствиям.
 *
 * Смысл для нашей задачи прямой: снять точку перед массовой правкой
 * трассировки и откатиться, если что-то пошло не так.
 */
function SavePoints({ connection }: { connection: Connection }) {
  const { t } = useI18n()
  const load = useCallback((connection: Connection) => apiSavePoints(connection), [])
  const { data, loading, error, reload, setError } = useApiData<SavePoint[]>(connection, load)

  const [busy, setBusy] = useState<'create' | 'rollback' | 'delete' | null>(null)
  const [confirm, setConfirm] = useState<{ point: SavePoint; action: 'rollback' | 'delete' } | null>(null)

  const create = useCallback(async () => {
    setBusy('create')
    setError(null)
    try {
      await apiCreateSavePoint(connection)
      await reload()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }, [connection, reload, setError])

  const run = useCallback(async () => {
    if (!confirm) return
    const { point, action } = confirm
    setConfirm(null)
    setBusy(action)
    setError(null)
    try {
      if (action === 'rollback') await apiRollbackSavePoint(connection, point)
      else await apiDeleteSavePoint(connection, point)
      await reload()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }, [confirm, connection, reload, setError])

  const points = data ?? []

  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-5 py-2.5">
        <span className="text-[12.5px] font-semibold">{t('savepoints.title')}</span>
        <span className="text-[11px] text-content-subtle">{t('savepoints.hint')}</span>
        <Button
          size="sm"
          className="ml-auto"
          onClick={() => void create()}
          disabled={busy !== null}
          title={t('savepoints.create.hint')}
        >
          {busy === 'create' ? <><Spinner className="size-3.5" /> {t('savepoints.creating')}</> : t('savepoints.create')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void reload()} disabled={loading || busy !== null}>
          {loading ? <Spinner className="size-3.5" /> : '↻'}
        </Button>
      </div>

      {error && <p className="mx-5 mt-3 rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-negative">{error}</p>}

      <div className="px-5 py-3">
        {points.length === 0 ? (
          <p className="text-[11.5px] text-content-subtle">
            {loading ? t('empty.scanning') : t('savepoints.none')}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {points.map((point) => (
              <div key={point.filename} className="flex items-center gap-3 rounded-lg border border-line-strong bg-surface-2/50 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[11.5px]">{point.filename}</span>
                  <span className="block text-[10.5px] text-content-subtle">
                    {point.date ? point.date.replace('T', ' ').slice(0, 19) : '—'}
                    {point.version ? ` · FESB ${point.version}` : ''}
                  </span>
                </span>
                <Button size="sm" disabled={busy !== null} onClick={() => setConfirm({ point, action: 'rollback' })}>
                  {t('savepoints.rollback')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirm({ point, action: 'delete' })}>
                  {t('properties.delete')}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        closeLabel={t('action.close')}
        title={confirm?.action === 'rollback' ? t('savepoints.confirm.rollback') : t('savepoints.confirm.delete')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>{t('action.cancel')}</Button>
            <Button variant="primary" onClick={() => void run()}>
              {confirm?.action === 'rollback' ? t('savepoints.rollback') : t('properties.delete')}
            </Button>
          </>
        }
      >
        {confirm && (
          <div className="space-y-3 text-[13px] leading-relaxed">
            <code className="block break-all rounded bg-accent/12 px-2 py-1 font-mono text-accent-content">
              {confirm.point.filename}
            </code>
            {confirm.action === 'rollback' ? (
              <p className="rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-negative">
                {t('savepoints.confirm.rollbackText')}
              </p>
            ) : (
              <p className="text-content-muted">{t('savepoints.confirm.deleteText')}</p>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

function Action({ label, busy, disabled, onClick }: {
  label: string
  busy: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Button size="sm" onClick={onClick} disabled={disabled || busy}>
      {busy ? <Spinner className="size-3.5" /> : label}
    </Button>
  )
}
