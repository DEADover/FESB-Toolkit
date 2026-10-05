import type { MessageKey, Translate } from '../i18n'
import type {
  ApiEndpoint, CertificateReport, DomainStat, ModuleRow, PassportWalk, QueueManager, QueueRow, RouteSummary,
  ServerUsage, SweepRow,
} from '../types'
import { routeStateLabel } from './routeState'

/** Разделы паспорта — по листу на каждый, плюс сводка первым листом. */
export type PassportSection =
  | 'domains'
  | 'routes'
  | 'links'
  | 'endpoints'
  | 'queues'
  | 'constants'
  | 'certificates'
  | 'modules'

export const PASSPORT_SECTIONS: PassportSection[] = [
  'domains', 'routes', 'links', 'endpoints', 'queues', 'constants', 'certificates', 'modules',
]

/** Разделы, которым нужен обход конфигурации стенда: он и есть самое долгое. */
export const WALK_SECTIONS: PassportSection[] = ['domains', 'routes', 'links', 'endpoints']

export interface PassportData {
  /** Местное время сборки: `2026-10-05T13:05:04`. */
  builtAt: string
  stand: { name: string; url: string; user: string }
  usage: ServerUsage | null
  walk: PassportWalk | null
  stats: DomainStat[] | null
  routes: RouteSummary[] | null
  constants: SweepRow[] | null
  queues: Array<{ manager: QueueManager; rows: QueueRow[] }> | null
  certificates: CertificateReport | null
  modules: ModuleRow[] | null
  /** Что собрать не удалось — попадает в сводку, а не обрывает паспорт. */
  failures: Array<{ section: PassportSection; error: string }>
  /** Что собралось не целиком: лист есть, но части колонок не хватает. */
  warnings: string[]
}

export interface Sheet {
  name: string
  headers: string[]
  rows: string[][]
}

const SHEET_TITLE: Record<PassportSection, MessageKey> = {
  domains: 'passport.section.domains',
  routes: 'passport.section.routes',
  links: 'passport.section.links',
  endpoints: 'passport.section.endpoints',
  queues: 'passport.section.queues',
  constants: 'passport.section.constants',
  certificates: 'passport.section.certificates',
  modules: 'passport.section.modules',
}

export function sectionTitle(section: PassportSection, t: Translate): string {
  return t(SHEET_TITLE[section])
}

/** `2026-10-05T13:05:04` → `05.10.2026 13:05`; дата без времени — без времени. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return ''
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(value)
  if (!match) return value
  const date = `${match[3]}.${match[2]}.${match[1]}`
  return match[4] ? `${date} ${match[4]}:${match[5]}` : date
}

/** Сколько дней осталось до конца действия; отрицательное — уже просрочен. */
export function daysLeft(notAfter: string, now = Date.now()): number | null {
  const end = new Date(notAfter).getTime()
  if (Number.isNaN(end)) return null
  return Math.floor((end - now) / 86_400_000)
}

const yesNo = (value: boolean | null | undefined, t: Translate) =>
  value === null || value === undefined ? '' : value ? t('endpoints.yes') : t('endpoints.no')

/** Точка одной строкой: «HTTP jetty:http://0.0.0.0:8080/orders». */
function pointText(point: ApiEndpoint): string {
  return `${point.kind} ${point.uri}`
}

function routeKey(domainGuid: string, id: string): string {
  return `${domainGuid}|${id}`
}

function routeStateText(state: string | undefined, t: Translate): string {
  return state ? routeStateLabel(state, t) : t('passport.state.unknown')
}

function domainsSheet(data: PassportData, t: Translate): Sheet | null {
  if (!data.walk) return null
  const stats = new Map((data.stats ?? []).map((item) => [item.guid, item]))
  return {
    name: sectionTitle('domains', t),
    headers: [
      t('table.domain'), t('passport.col.group'), t('passport.col.description'), t('passport.col.tags'),
      t('table.state'), t('passport.col.routes'), t('passport.col.running'), t('passport.col.errors'), t('passport.col.guid'),
    ],
    rows: data.walk.domains.map((domain) => {
      const stat = stats.get(domain.guid)
      return [
        domain.name,
        domain.group ?? '',
        domain.description ?? '',
        domain.tags ?? '',
        stat ? (stat.active ? t('passport.state.started') : t('passport.state.stopped')) : '',
        String(domain.routes),
        stat ? String(stat.running) : '',
        stat ? String(stat.errors) : '',
        domain.guid,
      ]
    }),
  }
}

function routesSheet(data: PassportData, t: Translate): Sheet | null {
  if (!data.walk) return null
  // СОПС узнаётся по домену и идентификатору вместе: скопированный домен
  // приносит те же `route-…`, и по одному идентификатору строки чужого
  // домена получали состояние и точки двойника.
  const live = new Map((data.routes ?? []).map((item) => [routeKey(item.domainGuid, item.id), item]))
  const points = new Map<string, { in: string[]; out: string[] }>()
  for (const point of data.walk.endpoints) {
    // Точки дополнительных маршрутов (`route-1:part`) — точки их СОПС.
    const key = routeKey(point.domainGuid, point.routeId.split(':')[0])
    const slot = points.get(key) ?? { in: [], out: [] }
    slot[point.direction].push(pointText(point))
    points.set(key, slot)
  }
  // Состояние не прочиталось — колонки пустые, а не «не загружен в шину»:
  // иначе сбой одного шага выглядел бы как стенд без единого СОПС.
  const known = data.routes !== null
  return {
    name: sectionTitle('routes', t),
    headers: [
      t('table.domain'), t('table.route'), t('passport.col.purpose'), t('table.state'), t('passport.col.trace'),
      t('passport.col.traceBeans'), t('passport.col.entries'), t('passport.col.exits'), t('passport.col.steps'),
      t('passport.col.transacted'), t('passport.col.processed'), t('passport.col.failed'), t('passport.col.last'),
      t('passport.col.routeId'),
    ],
    rows: data.walk.routes.map((route) => {
      const key = route.id ? routeKey(route.domainGuid, route.id) : null
      const row = key ? live.get(key) : undefined
      const slot = (key && points.get(key)) || { in: [], out: [] }
      return [
        route.domain,
        route.name ?? route.id ?? '',
        route.description ?? '',
        row ? routeStateText(row.state, t) : known ? t('passport.state.notDeployed') : '',
        row ? yesNo(row.trace, t) : '',
        row ? row.traceBeans.join(', ') : '',
        slot.in.join('\n'),
        slot.out.join('\n'),
        String(route.steps),
        yesNo(route.transacted, t),
        row ? String(row.processed) : '',
        row ? String(row.failed) : '',
        formatDate(row?.lastProcessed),
        route.id ?? '',
      ]
    }),
  }
}

function linksSheet(data: PassportData, t: Translate): Sheet | null {
  if (!data.walk) return null
  return {
    name: sectionTitle('links', t),
    headers: [
      t('passport.col.fromDomain'), t('passport.col.fromRoute'), t('passport.col.toDomain'), t('passport.col.toRoute'),
      t('passport.col.linkKind'), t('passport.col.address'),
    ],
    rows: data.walk.links.map((link) => [
      link.fromDomain, link.fromRoute, link.toDomain, link.toRoute,
      link.kind === 'call' ? t('passport.link.call') : t('passport.link.queue'),
      link.uri,
    ]),
  }
}

function endpointsSheet(data: PassportData, t: Translate): Sheet | null {
  if (!data.walk) return null
  return {
    name: sectionTitle('endpoints', t),
    headers: [
      t('table.domain'), t('table.route'), t('endpoints.direction'), t('endpoints.kind'), t('route.uri'),
      t('endpoints.manager'), t('endpoints.port'), t('endpoints.listening'), t('endpoints.ssl'), t('endpoints.protocol'),
      t('endpoints.auth'), t('table.state'),
    ],
    rows: data.walk.endpoints.map((point) => [
      point.domain,
      point.route,
      point.direction === 'in' ? t('endpoints.in') : t('endpoints.out'),
      point.kind,
      point.uri,
      point.manager ?? '',
      point.port === null ? '' : String(point.port),
      point.listening === null ? '' : point.listening ? t('endpoints.yes') : t('endpoints.listening.no'),
      yesNo(point.ssl, t),
      point.protocol ?? '',
      point.auth ?? '',
      point.state ?? '',
    ]),
  }
}

function queuesSheet(data: PassportData, t: Translate): Sheet | null {
  if (!data.queues) return null
  return {
    name: sectionTitle('queues', t),
    headers: [
      t('passport.col.manager'), t('passport.col.managerState'), t('passport.col.queue'), t('passport.col.messages'),
      t('passport.col.consumers'), t('passport.col.producers'), t('passport.col.durable'), t('passport.col.paused'),
    ],
    // Служебные очереди менеджера в паспорт не идут: их заводит сама шина,
    // и сопровождению они ничего не говорят.
    rows: data.queues.flatMap(({ manager, rows }) => rows.filter((row) => !row.internal).map((row) => [
      manager.broker,
      manager.running ? t('passport.state.started') : t('passport.state.stopped'),
      row.name,
      String(row.messages),
      String(row.consumers),
      row.producers === null ? '' : String(row.producers),
      yesNo(row.durable, t),
      yesNo(row.paused, t),
    ])),
  }
}

export function scopeText(row: SweepRow, t: Translate): string {
  if (row.scope === 'application') return t('properties.scope.application')
  if (row.scope === 'broker') return t('properties.scope.broker')
  return t('passport.scope.domain')
}

function constantsSheet(data: PassportData, t: Translate): Sheet | null {
  if (!data.constants) return null
  return {
    name: sectionTitle('constants', t),
    headers: [
      t('passport.col.level'), t('table.domain'), t('passport.col.constant'), t('passport.col.value'), t('passport.col.description'),
    ],
    rows: data.constants.map((row) => [
      scopeText(row, t),
      row.domain ?? '',
      row.key,
      // Значение скрытой константы шина не отдаёт, а и отдавала бы — в файл,
      // который пересылают по почте, ему не место.
      row.secured || row.vault ? t('passport.hidden') : row.value ?? '',
      row.description ?? '',
    ]),
  }
}

function certificatesSheet(data: PassportData, t: Translate, now: number): Sheet | null {
  if (!data.certificates) return null
  return {
    name: sectionTitle('certificates', t),
    headers: [
      t('certificates.store'), t('certificates.alias'), t('certificates.subject'), t('certificates.issuer'),
      t('certificates.validFrom'), t('certificates.validTo'), t('certificates.left'), t('certificates.serial'),
    ],
    rows: data.certificates.certificates.map((row) => {
      const left = daysLeft(row.notAfter, now)
      return [
        row.store,
        row.alias,
        row.subjectName,
        row.issuerName,
        formatDate(row.notBefore),
        formatDate(row.notAfter),
        left === null ? '' : left < 0 ? t('certificates.expiredLabel') : t('certificates.days', { count: left }),
        row.serial,
      ]
    }),
  }
}

function modulesSheet(data: PassportData, t: Translate): Sheet | null {
  if (!data.modules) return null
  return {
    name: sectionTitle('modules', t),
    headers: [t('passport.col.module'), t('passport.col.moduleName'), t('passport.col.enabled'), t('table.state'), t('passport.col.dependencies')],
    rows: data.modules.map((row) => [
      row.label || row.name,
      row.name,
      yesNo(row.active, t),
      row.running ? t('passport.state.started') : t('passport.state.stopped'),
      row.dependencies.join(', '),
    ]),
  }
}

/** Первый лист: что это за стенд и что в паспорте. */
function summarySheet(data: PassportData, sheets: Array<{ section: PassportSection; sheet: Sheet }>, t: Translate, now: number): Sheet {
  const rows: string[][] = [
    [t('passport.summary.stand'), data.stand.name],
    [t('passport.summary.url'), data.stand.url],
    [t('passport.summary.version'), data.usage?.version ?? ''],
    [t('passport.summary.user'), data.stand.user],
    [t('passport.summary.builtAt'), formatDate(data.builtAt)],
  ]
  if (data.walk) {
    const running = (data.stats ?? []).filter((item) => item.active).length
    rows.push([t('passport.summary.domains'), data.stats ? t('passport.summary.domainsValue', { total: data.walk.domains.length, running }) : String(data.walk.domains.length)])
    rows.push([t('passport.summary.routes'), String(data.walk.routes.length)])
  }
  if (data.certificates) {
    const soon = data.certificates.certificates.filter((row) => {
      const left = daysLeft(row.notAfter, now)
      return left !== null && left <= 90
    }).length
    rows.push([t('passport.summary.expiring'), String(soon)])
  }
  if (data.constants) {
    const hidden = data.constants.filter((row) => row.secured || row.vault).length
    if (hidden > 0) rows.push([t('passport.summary.hidden'), String(hidden)])
  }
  for (const { sheet } of sheets) rows.push([t('passport.summary.sheet', { name: sheet.name }), t('passport.summary.rows', { count: sheet.rows.length })])
  for (const failure of data.failures) {
    rows.push([t('passport.summary.failed', { name: sectionTitle(failure.section, t) }), failure.error])
  }
  for (const warning of data.warnings) rows.push([t('passport.summary.warning'), warning])
  return { name: t('passport.sheet.summary'), headers: [t('passport.col.item'), t('passport.col.value')], rows }
}

/**
 * Книга паспорта: сводка и по листу на каждый собранный раздел.
 *
 * Раздел, который выбрали, но собрать не смогли, листа не получает — его
 * причина стоит в сводке. Пустой лист читался бы как «на стенде ничего нет».
 */
export function buildSheets(data: PassportData, sections: Set<PassportSection>, t: Translate, now = Date.now()): Sheet[] {
  const builders: Record<PassportSection, () => Sheet | null> = {
    domains: () => domainsSheet(data, t),
    routes: () => routesSheet(data, t),
    links: () => linksSheet(data, t),
    endpoints: () => endpointsSheet(data, t),
    queues: () => queuesSheet(data, t),
    constants: () => constantsSheet(data, t),
    certificates: () => certificatesSheet(data, t, now),
    modules: () => modulesSheet(data, t),
  }
  const failed = new Set(data.failures.map((failure) => failure.section))
  const sheets = PASSPORT_SECTIONS
    .filter((section) => sections.has(section) && !failed.has(section))
    .flatMap((section) => {
      const sheet = builders[section]()
      return sheet ? [{ section, sheet }] : []
    })
  return [summarySheet(data, sheets, t, now), ...sheets.map((item) => item.sheet)]
}

/** Имя файла: хост стенда и время — паспорта разных стендов не путаются. */
export function passportFileName(url: string, stamp: string): string {
  const host = url.replace(/^https?:\/\//, '').split(/[/:]/)[0].replace(/[^A-Za-z0-9.-]/g, '-') || 'fesb'
  return `fesb-passport-${host}-${stamp}.xlsx`
}
