import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { CheckCircle, Circle, DownloadSimple, IdentificationCard, MinusCircle, WarningCircle } from '@phosphor-icons/react'

import { formatNumber, useI18n, type MessageKey } from '../i18n'
import {
  apiCertificates, apiDomainStatistics, apiModules, apiPassportWalk, apiPropertiesSweep, apiQueueManagers, apiQueues,
  apiRoutesOverview, apiServerUsage, errorText, onApiProgress, revealPath, saveWorkbook, saveXlsxAs,
} from '../lib/api'
import {
  buildSheets, PASSPORT_SECTIONS, passportFileName, sectionTitle, WALK_SECTIONS,
  type PassportData, type PassportSection, type Sheet,
} from '../lib/passport'
import { localStamp, localTime } from '../lib/paths'
import type { ApiProgress, Connection, ServerInfo } from '../types'
import { ErrorBar, NotConnected, Panel, ScreenBody } from './ApiShell'
import { useToast } from './Toaster'
import { Button, ButtonGlyph, Checkbox, cx, Notice, Readout, Spinner } from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  onGoToConnection: () => void
  /** Имя стенда из подключений — им паспорт и подписан. */
  standName: string | null
}

const SECTION_HINT: Record<PassportSection, MessageKey> = {
  domains: 'passport.hint.domains',
  routes: 'passport.hint.routes',
  links: 'passport.hint.links',
  endpoints: 'passport.hint.endpoints',
  queues: 'passport.hint.queues',
  constants: 'passport.hint.constants',
  certificates: 'passport.hint.certificates',
  modules: 'passport.hint.modules',
}

type StageId = 'about' | 'walk' | 'state' | 'queues' | 'constants' | 'certificates' | 'modules'

const STAGE_LABEL: Record<StageId, MessageKey> = {
  about: 'passport.stage.about',
  walk: 'passport.stage.walk',
  state: 'passport.stage.state',
  queues: 'passport.stage.queues',
  constants: 'passport.stage.constants',
  certificates: 'passport.stage.certificates',
  modules: 'passport.stage.modules',
}

interface Stage {
  id: StageId
  status: 'waiting' | 'running' | 'done' | 'failed'
  detail?: string
}

/** Какие шаги нужны выбранным разделам. Сведения о стенде — всегда. */
function stagesFor(sections: Set<PassportSection>): StageId[] {
  const needsWalk = WALK_SECTIONS.some((section) => sections.has(section))
  const stages: StageId[] = ['about']
  if (needsWalk) stages.push('walk')
  if (sections.has('domains') || sections.has('routes')) stages.push('state')
  for (const id of ['queues', 'constants', 'certificates', 'modules'] as const) {
    if (sections.has(id)) stages.push(id)
  }
  return stages
}

/**
 * Паспорт стенда: описание для передачи на сопровождение одним файлом.
 *
 * Всё это по отдельности уже есть на других экранах, но паспорт нужен целиком
 * и в одном месте: его отдают дежурной смене или заказчику при сдаче проекта.
 * Значения скрытых констант в файл не попадают.
 */
export function PassportScreen({ connection, server, onGoToConnection, standName }: Props) {
  const { t } = useI18n()
  const toast = useToast()
  const [sections, setSections] = useState<Set<PassportSection>>(() => new Set(PASSPORT_SECTIONS))
  const [stages, setStages] = useState<Stage[] | null>(null)
  const [data, setData] = useState<PassportData | null>(null)
  const [built, setBuilt] = useState<Set<PassportSection>>(new Set())
  const [building, setBuilding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<ApiProgress | null>(null)
  const current = useRef<StageId | null>(null)

  // Обход и выгрузка констант сообщают о ходе событиями — показываем их
  // у того шага, который сейчас идёт.
  useEffect(() => {
    const stop = onApiProgress((event) => { if (current.current) setProgress(event) })
    return () => { void stop.then((off) => off()) }
  }, [])

  // Сменили стенд — собранный паспорт относится к прежнему.
  useEffect(() => {
    setData(null)
    setStages(null)
  }, [connection])

  const toggle = (section: PassportSection) => setSections((prev) => {
    const next = new Set(prev)
    if (next.has(section)) next.delete(section)
    else next.add(section)
    return next
  })

  const build = useCallback(async () => {
    if (!connection || !server) return
    const chosen = new Set(sections)
    const plan = stagesFor(chosen)
    let list: Stage[] = plan.map((id) => ({ id, status: 'waiting' }))
    const update = (id: StageId, patch: Partial<Stage>) => {
      list = list.map((stage) => (stage.id === id ? { ...stage, ...patch } : stage))
      setStages(list)
    }
    setStages(list)
    setData(null)
    setError(null)
    setBuilding(true)

    const result: PassportData = {
      builtAt: localTime(),
      stand: { name: standName ?? server.baseUrl, url: server.baseUrl, user: server.user },
      usage: null, walk: null, stats: null, routes: null, constants: null, queues: null, certificates: null, modules: null,
      failures: [], warnings: [],
    }

    // Каждый шаг сам по себе: упавший раздел не должен стоить остальных.
    const step = async (id: StageId, work: () => Promise<string | undefined>, onFail: (message: string) => void) => {
      current.current = id
      setProgress(null)
      update(id, { status: 'running' })
      try {
        update(id, { status: 'done', detail: await work() })
      } catch (err) {
        const message = errorText(err)
        onFail(message)
        update(id, { status: 'failed', detail: message })
      }
    }

    for (const id of plan) {
      if (id === 'about') {
        await step(id, async () => {
          result.usage = await apiServerUsage(connection)
          return result.usage.version ? `FESB ${result.usage.version}` : undefined
        }, (message) => result.warnings.push(`${t('passport.stage.about')}: ${message}`))
      } else if (id === 'walk') {
        await step(id, async () => {
          result.walk = await apiPassportWalk(connection)
          return t('passport.stage.walk.done', {
            domains: result.walk.domains.length, routes: result.walk.routes.length,
            points: result.walk.endpoints.length, links: result.walk.links.length,
          })
        }, (message) => {
          for (const section of WALK_SECTIONS) if (chosen.has(section)) result.failures.push({ section, error: message })
        })
      } else if (id === 'state') {
        await step(id, async () => {
          const [stats, routes] = await Promise.all([apiDomainStatistics(connection), apiRoutesOverview(connection)])
          result.stats = stats
          result.routes = routes
          return t('passport.stage.state.done', { domains: stats.length, routes: routes.length })
        }, (message) => result.warnings.push(`${t('passport.stage.state')}: ${message}`))
      } else if (id === 'queues') {
        await step(id, async () => {
          const managers = await apiQueueManagers(connection)
          const collected: PassportData['queues'] = []
          for (const manager of managers) {
            // Остановленный менеджер очередей не отвечает — его просто нет в листе.
            if (!manager.running) continue
            collected.push({ manager, rows: await apiQueues(connection, manager.kind, manager.id) })
          }
          result.queues = collected
          const total = collected.reduce((sum, item) => sum + item.rows.filter((row) => !row.internal).length, 0)
          return t('passport.stage.queues.done', { managers: collected.length, queues: total })
        }, (message) => result.failures.push({ section: 'queues', error: message }))
      } else if (id === 'constants') {
        await step(id, async () => {
          result.constants = await apiPropertiesSweep(connection)
          return t('passport.stage.count', { count: result.constants.length })
        }, (message) => result.failures.push({ section: 'constants', error: message }))
      } else if (id === 'certificates') {
        await step(id, async () => {
          result.certificates = await apiCertificates(connection)
          return t('passport.stage.count', { count: result.certificates.certificates.length })
        }, (message) => result.failures.push({ section: 'certificates', error: message }))
      } else if (id === 'modules') {
        await step(id, async () => {
          result.modules = await apiModules(connection)
          return t('passport.stage.count', { count: result.modules.length })
        }, (message) => result.failures.push({ section: 'modules', error: message }))
      }
    }

    current.current = null
    setProgress(null)
    setData(result)
    setBuilt(chosen)
    setBuilding(false)
  }, [connection, server, sections, standName, t])

  const sheets = useMemo<Sheet[]>(() => (data ? buildSheets(data, built, t) : []), [data, built, t])

  const save = useCallback(async () => {
    if (!data) return
    const output = await saveXlsxAs(t('passport.save'), passportFileName(data.stand.url, localStamp()))
    if (!output) return
    setSaving(true)
    setError(null)
    try {
      await saveWorkbook(output, sheets)
      toast({
        tone: 'ok',
        title: t('report.saved'),
        text: `${output.split(/[/\\]/).pop()} · ${t('passport.savedSheets', { count: sheets.length })}`,
        action: { label: t('action.reveal'), onClick: () => void revealPath(output) },
      })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }, [data, sheets, t, toast])

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  const needsWalk = WALK_SECTIONS.some((section) => sections.has(section))

  return (
    <ScreenBody>
      {/* Экран читается как документ сверху вниз: шаги и итог дописываются
          под выбором разделов, и прокручивается он целиком, а панели не
          сжимаются по высоте окна, обрезая друг друга. */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
        <Panel>
          <div className="space-y-4 p-4">
            <div className="flex items-start gap-3">
              <IdentificationCard size={22} className="mt-0.5 shrink-0 text-accent-content" />
              <div className="min-w-0">
                <h2 className="text-[14px] font-semibold">{t('passport.intro.title')}</h2>
                <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-content-muted">{t('passport.intro.text')}</p>
              </div>
            </div>

            <fieldset disabled={building} className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <legend className="sr-only">{t('passport.sections')}</legend>
              {PASSPORT_SECTIONS.map((section) => (
                <label
                  key={section}
                  className={cx(
                    'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition',
                    sections.has(section) ? 'border-accent/40 bg-accent/6' : 'border-line hover:bg-surface-2',
                  )}
                >
                  <Checkbox className="mt-0.5" checked={sections.has(section)} onChange={() => toggle(section)} />
                  <span className="min-w-0">
                    <span className="block text-[12.5px] font-medium">{sectionTitle(section, t)}</span>
                    <span className="mt-0.5 block text-[11.5px] leading-snug text-content-subtle">{t(SECTION_HINT[section])}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                className="min-w-48"
                disabled={building || sections.size === 0}
                onClick={() => void build()}
              >
                <ButtonGlyph busy={building}><IdentificationCard size={14} weight="bold" /></ButtonGlyph>
                {data ? t('passport.rebuild') : t('passport.build')}
              </Button>
              <p className="text-[11.5px] text-content-subtle">
                {needsWalk ? t('passport.walkNote') : t('passport.quickNote')} {t('passport.secretsNote')}
              </p>
            </div>
          </div>
        </Panel>

        <ErrorBar error={error} />

        {stages && (
          <Panel>
            <ol className="divide-y divide-line/60">
              {stages.map((stage) => (
                <li key={stage.id} className="flex items-start gap-3 px-4 py-2.5 text-[12.5px]">
                  <StageIcon status={stage.status} />
                  <span className="w-72 shrink-0 font-medium">{t(STAGE_LABEL[stage.id])}</span>
                  <span className={cx('min-w-0 flex-1 break-words', stage.status === 'failed' ? 'text-negative' : 'text-content-muted')}>
                    {stage.status === 'running' && progress && progress.total > 0
                      ? t('passport.stage.progress', { current: progress.current, total: progress.total })
                      : stage.detail ?? (stage.status === 'waiting' ? t('passport.stage.waiting') : '')}
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
        )}

        {data && (
          <Panel>
            <div className="space-y-3 p-4">
              {data.failures.length > 0 && (
                <Notice tone="warn" small>{t('passport.partial', { count: data.failures.length })}</Notice>
              )}
              <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
                {sheets.slice(1).map((sheet) => (
                  <Readout key={sheet.name} label={sheet.name} value={formatNumber(sheet.rows.length)} />
                ))}
                <div className="ml-auto">
                  <Button variant="primary" className="min-w-52" disabled={saving} onClick={() => void save()}>
                    <ButtonGlyph busy={saving}><DownloadSimple size={14} weight="bold" /></ButtonGlyph>
                    {t('passport.export')}
                  </Button>
                </div>
              </div>
              <p className="text-[11.5px] text-content-subtle">{t('passport.exportNote', { count: sheets.length })}</p>
            </div>
          </Panel>
        )}
      </div>
    </ScreenBody>
  )
}

function StageIcon({ status }: { status: Stage['status'] }) {
  if (status === 'running') return <Spinner className="mt-0.5 size-4 shrink-0" />
  if (status === 'done') return <CheckCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-positive" />
  if (status === 'failed') return <WarningCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-negative" />
  if (status === 'waiting') return <Circle size={16} className="mt-0.5 shrink-0 text-content-subtle" />
  return <MinusCircle size={16} className="mt-0.5 shrink-0 text-content-subtle" />
}
