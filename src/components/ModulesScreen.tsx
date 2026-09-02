import { useCallback, useState } from 'react'

import { ArrowCounterClockwise, ArrowsClockwise, Play, Stop, Trash } from '@phosphor-icons/react'

import { useI18n } from '../i18n'
import {
  apiCreateSavePoint, apiDeleteSavePoint, apiModuleAction, apiModules, apiRollbackSavePoint,
  apiSavePoints, errorText,
} from '../lib/api'
import type { Connection, ModuleAction, ModuleRow, SavePoint, ServerInfo } from '../types'
import { Awaiting, ErrorBar, NotConnected, Panel, RefreshButton, TableMessage, useApiData } from './ApiShell'
import {
  Badge, Button, ButtonGlyph, cx, DataTable, IconButton, Modal, Notice, Spinner, Th, THead,
} from './ui'

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
  // В зависимостях шина называет модули техническими кодами — показываем имена.
  const labels = new Map(modules.map((module) => [module.name, module.label]))

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pb-4">
      <div className="flex items-center gap-3">
        <span className="text-[11.5px] text-content-subtle">
          {t('api.modules', { running, total: modules.length })}
        </span>
        {modules.some((module) => module.awaitRestart) && (
          <Badge tone="warn">{t('modules.awaitRestartHint')}</Badge>
        )}
        <RefreshButton className="ml-auto"
          busy={loading}
          disabled={loading || pending !== null}
          onClick={() => void reload()}
        />
      </div>

      <ErrorBar error={error} />

      <Panel className="shrink-0">
        <DataTable>
          <colgroup>
            {/* Имя модуля забирает остаток: колонки под ним подобраны так,
                чтобы на минимальной ширине окна (1020) ему оставалось место. */}
            <col />
            <col className="w-44" />
            <col className="w-28" />
            <col className="w-32" />
            <col className="w-28" />
          </colgroup>
          <THead>
              <Th>{t('modules.module')}</Th>
              <Th>{t('modules.code')}</Th>
              <Th>{t('modules.dependencies')}</Th>
              <Th>{t('table.state')}</Th>
              <Th>{t('modules.actions')}</Th>
            </THead>
          <tbody>
            {modules.map((module) => (
              <tr key={module.name} className={cx('border-b border-line/60', !module.active && 'text-content-subtle')}>
                <td className="truncate px-3 py-2 font-medium" title={module.label}>{module.label}</td>
                <td className="truncate px-3 py-2 font-mono text-[11px] text-content-subtle" title={module.name}>
                  {module.name}
                </td>
                <td className="truncate px-3 py-2" title={module.dependencies.join(', ')}>
                  {module.dependencies.length > 0
                    ? module.dependencies.map((name) => labels.get(name) ?? name).join(', ')
                    : '—'}
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
                  <div className="flex items-center gap-1">
                    <IconButton
                      icon={Play}
                      label={t('modules.start')}
                      busy={pending === `${module.name}:start`}
                      disabled={pending !== null || module.running}
                      onClick={() => start(module, 'start')}
                    />
                    <IconButton
                      icon={Stop}
                      label={t('modules.stop')}
                      busy={pending === `${module.name}:stop`}
                      disabled={pending !== null || !module.running}
                      onClick={() => start(module, 'stop')}
                    />
                    <IconButton
                      icon={ArrowsClockwise}
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
              <TableMessage colSpan={5} busy={loading}>{loading ? t('empty.scanning') : t('table.empty')}</TableMessage>
            )}
          </tbody>
        </DataTable>
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
              <Notice tone="warn">
                {t('modules.confirm.broker')}
              </Notice>
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
        <Button
          size="sm"
          variant="ghost"
          aria-label={t('action.refresh')}
          title={t('action.refresh')}
          onClick={() => void reload()}
          disabled={loading || busy !== null}
        >
          <ButtonGlyph busy={loading}><ArrowsClockwise size={13} weight="bold" /></ButtonGlyph>
        </Button>
      </div>

      {error && <Notice tone="danger" className="mx-5 mt-3">{error}</Notice>}

      <div className="px-5 py-3">
        {points.length === 0 ? (
          <p className="text-[11.5px] text-content-subtle">
            <Awaiting busy={loading}>{loading ? t('empty.scanning') : t('savepoints.none')}</Awaiting>
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
                <IconButton
                  icon={ArrowCounterClockwise}
                  label={t('savepoints.rollback')}
                  disabled={busy !== null}
                  onClick={() => setConfirm({ point, action: 'rollback' })}
                />
                <IconButton
                  icon={Trash}
                  label={t('properties.delete')}
                  tone="danger"
                  disabled={busy !== null}
                  onClick={() => setConfirm({ point, action: 'delete' })}
                />
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
              <Notice tone="danger">
                {t('savepoints.confirm.rollbackText')}
              </Notice>
            ) : (
              <p className="text-content-muted">{t('savepoints.confirm.deleteText')}</p>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

