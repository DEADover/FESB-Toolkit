import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open, save } from '@tauri-apps/plugin-dialog'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'

import type {
  ApiDomain, ApiProgress, AppInfo, ApplyProgress, ApplyReport, ApplyTarget, ArchiveProgress,
  AccessReport, ApiEndpoint, ArchiveResult, CertificateReport, InflightExchange, ReportEntry,
  RouteSummary, ServerUsage, StoredReport, AuditEntry, Connection, DomainAction, DomainActionResult,
  DomainRoutes, DomainStat,
  ExtractResult, LinkGraph, LogEntry,
  LogFileRow, LogRequest, ManagerKind,
  ModuleAction, ModuleRow, PropertyRow, PropertyScope, PullResult, PushResult, QueueManager,
  QueueMatch, QueueMessage, QueueRow, RouteAction, RouteGraph, RouteState, SavePoint, ScanProgress,
  ScanResult,
  Comparison, ServerInfo, SweepRow, TraceUpdate, VerifyResult,
} from '../types'

/** Единственная точка соприкосновения интерфейса с бэкендом на Rust. */

export async function selectFolder(title: string): Promise<string | null> {
  const result = await open({ directory: true, multiple: false, title })
  return typeof result === 'string' ? result : null
}

export async function selectArchive(title: string): Promise<string | null> {
  const result = await open({
    directory: false,
    multiple: false,
    title,
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
  })
  return typeof result === 'string' ? result : null
}

/**
 * Путь к файлу через системное окно.
 *
 * Фильтры идут в том порядке, в каком их показывает система: первым —
 * нужные расширения, последним обычно «все файлы», иначе выбрать
 * сертификат с непривычным именем нельзя.
 */
export async function selectFile(
  title: string,
  filters: Array<{ name: string; extensions: string[] }>,
): Promise<string | null> {
  const result = await open({ directory: false, multiple: false, title, filters })
  return typeof result === 'string' ? result : null
}

/** Распаковывает архив во временную папку и возвращает путь к ней. */
export function openArchive(path: string): Promise<ExtractResult> {
  return invoke<ExtractResult>('open_archive', { path })
}

export function scanDirectory(root: string): Promise<ScanResult> {
  return invoke<ScanResult>('scan_directory', { root })
}

export function applyTrace(request: {
  update: TraceUpdate
  targets: ApplyTarget[]
  makeBackup: boolean
  dryRun: boolean
}): Promise<ApplyReport> {
  return invoke<ApplyReport>('apply_trace', { request })
}

/**
 * Собирает zip-архив конфигурации для обратной загрузки в шину.
 * `domains` — пути к папкам доменов; `null` означает «весь экспорт».
 */
export function buildArchive(root: string, output: string, domains: string[] | null): Promise<ArchiveResult> {
  return invoke<ArchiveResult>('build_archive', { root, output, domains })
}

export function saveZipAs(title: string, defaultName: string): Promise<string | null> {
  return save({ title, defaultPath: defaultName, filters: [{ name: 'ZIP', extensions: ['zip'] }] })
}

export function saveXlsxAs(title: string, defaultName: string): Promise<string | null> {
  return save({ title, defaultPath: defaultName, filters: [{ name: 'Excel', extensions: ['xlsx'] }] })
}

/**
 * Отчёт по внешним точкам входа и выхода всех СОПС сервера.
 *
 * Сервер выкачивается целиком, поэтому долго: на стенде из 256 доменов
 * это полторы минуты. Прогресс приходит теми же событиями, что у выгрузки.
 */
export function apiEndpointReport(connection: Connection): Promise<ApiEndpoint[]> {
  return invoke<ApiEndpoint[]>('api_endpoint_report', { connection })
}

/**
 * Сертификаты из хранилищ ключей и доверенных хранилищ.
 *
 * Читается быстро — два запроса на списки и два на сами хранилища,
 * поэтому раздел открывается сразу, без кнопки «собрать».
 */
export function apiCertificates(connection: Connection): Promise<CertificateReport> {
  return invoke<CertificateReport>('api_certificates', { connection })
}

/**
 * Все СОПС сервера одним списком, вместе с их трассировкой.
 *
 * Шина отдаёт их за доли секунды — и запущенные, и остановленные. Раньше
 * тот же состав добывался выкачиванием всей конфигурации: полторы минуты
 * ради имён, которые лежали в одном методе.
 */
export function apiRoutesOverview(connection: Connection): Promise<RouteSummary[]> {
  return invoke<RouteSummary[]>('api_routes_overview', { connection })
}

/** Роли, права и открытые сеансы: кто что может делать на сервере. */
export function apiAccess(connection: Connection): Promise<AccessReport> {
  return invoke<AccessReport>('api_access', { connection })
}

/** Состояние сервера: время работы, память, процессор и диски. */
export function apiServerUsage(connection: Connection): Promise<ServerUsage> {
  return invoke<ServerUsage>('api_server_usage', { connection })
}

/** Обмены, которые шина ещё не довела до конца. */
export function apiInflight(connection: Connection): Promise<InflightExchange[]> {
  return invoke<InflightExchange[]>('api_inflight', { connection })
}

/**
 * История собранных отчётов по точкам.
 *
 * Отчёт собирается полторы минуты, и держать его только в памяти экрана
 * значит терять эти полторы минуты при каждом переходе. История лежит
 * в данных приложения и переживает перезапуск.
 */
export function reportHistory(): Promise<ReportEntry[]> {
  return invoke<ReportEntry[]>('report_history')
}

export function saveReportHistory(
  server: string,
  builtAt: string,
  endpoints: ApiEndpoint[],
): Promise<ReportEntry[]> {
  return invoke<ReportEntry[]>('save_report_history', { server, builtAt, endpoints })
}

export function readReportHistory(id: string): Promise<StoredReport> {
  return invoke<StoredReport>('read_report_history', { id })
}

export function deleteReportHistory(id: string): Promise<ReportEntry[]> {
  return invoke<ReportEntry[]>('delete_report_history', { id })
}

/** Пишет таблицу файлом Excel: шапка приходит уже переведённой. */
export function saveReport(path: string, sheet: string, headers: string[], rows: string[][]): Promise<void> {
  return invoke<void>('save_report', { path, sheet, headers, rows })
}

/** Разбирает файл СОПС в дерево шагов — из него рисуется схема. */
export function readRoute(path: string): Promise<RouteGraph[]> {
  return invoke<RouteGraph[]>('read_route', { path })
}

/** Связи СОПС между собой: кто кого вызывает адресом. */
export function routeLinks(root: string): Promise<LinkGraph> {
  return invoke<LinkGraph>('route_links', { root })
}

export function appInfo(): Promise<AppInfo> {
  return invoke<AppInfo>('app_info')
}

export async function revealPath(path: string): Promise<void> {
  try {
    await revealItemInDir(path)
  } catch {
    // Файл могли удалить между сканированием и кликом — молча игнорируем.
  }
}

export function onScanProgress(handler: (progress: ScanProgress) => void): Promise<UnlistenFn> {
  return listen<ScanProgress>('scan:progress', (event) => handler(event.payload))
}

export function onApplyProgress(handler: (progress: ApplyProgress) => void): Promise<UnlistenFn> {
  return listen<ApplyProgress>('apply:progress', (event) => handler(event.payload))
}

export function onArchiveProgress(handler: (progress: ArchiveProgress) => void): Promise<UnlistenFn> {
  return listen<ArchiveProgress>('archive:progress', (event) => handler(event.payload))
}

export function onExtractProgress(handler: (progress: ArchiveProgress) => void): Promise<UnlistenFn> {
  return listen<ArchiveProgress>('extract:progress', (event) => handler(event.payload))
}

/** Перетаскивание папки или архива в окно приложения. */
export function onFileDrop(handler: (paths: string[]) => void, onDragging: (active: boolean) => void): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === 'over') {
      onDragging(true)
      return
    }
    onDragging(false)
    if (event.payload.type === 'drop') handler(event.payload.paths)
  })
}

// ───────────────────────────── режим API ─────────────────────────────

/** Проверяет доступность шины и права пользователя. */
export function apiConnect(connection: Connection): Promise<ServerInfo> {
  return invoke<ServerInfo>('api_connect', { connection })
}

export function apiDomains(connection: Connection): Promise<ApiDomain[]> {
  return invoke<ApiDomain[]>('api_domains', { connection })
}

/** Забирает домены с сервера во временную папку; `null` — все домены сразу. */
export function apiPull(connection: Connection, guids: string[] | null): Promise<PullResult> {
  return invoke<PullResult>('api_pull', { connection, guids })
}

/** Отправляет отредактированные домены обратно в шину. */
export function apiPush(connection: Connection, root: string, guids: string[], reload: boolean): Promise<PushResult> {
  return invoke<PushResult>('api_push', { connection, root, guids, reload })
}

/** Забирает домены заново и сверяет трассировку с локальными файлами. */
export function apiVerify(connection: Connection, root: string, guids: string[]): Promise<VerifyResult> {
  return invoke<VerifyResult>('api_verify', { connection, root, guids })
}

export function apiRestartModule(connection: Connection, module: string): Promise<void> {
  return invoke<void>('api_restart_module', { connection, module })
}

export function onApiProgress(handler: (progress: ApiProgress) => void): Promise<UnlistenFn> {
  return listen<ApiProgress>('api:progress', (event) => handler(event.payload))
}

// ──────────────────── модули, очереди, константы, журналы ────────────────────

export function apiModules(connection: Connection): Promise<ModuleRow[]> {
  return invoke<ModuleRow[]>('api_modules', { connection })
}

export function apiModuleAction(connection: Connection, module: string, action: ModuleAction): Promise<void> {
  return invoke<void>('api_module_action', { connection, module, action })
}

export function apiDomainAction(
  connection: Connection,
  guid: string,
  action: DomainAction,
): Promise<DomainActionResult> {
  return invoke<DomainActionResult>('api_domain_action', { connection, guid, action })
}

/** Сводка по всем доменам сервера. */
export function apiDomainStatistics(connection: Connection): Promise<DomainStat[]> {
  return invoke<DomainStat[]>('api_domain_statistics', { connection })
}

/** Забирает один домен ради его СОПС — рабочую выгрузку не трогает. */
export function apiDomainRoutes(connection: Connection, guid: string): Promise<DomainRoutes> {
  return invoke<DomainRoutes>('api_domain_routes', { connection, guid })
}

/**
 * Репозиторий проекта.
 *
 * Единственный внешний адрес, который приложению разрешено открыть: права
 * в `capabilities/default.json` выданы ровно на него, а не на «любой https».
 */
export const REPOSITORY_URL = 'https://github.com/DEADover/FESB-Toolkit'

export function openRepository(): Promise<void> {
  return openUrl(REPOSITORY_URL)
}


export function apiRouteState(connection: Connection, domain: string, route: string): Promise<RouteState> {
  return invoke<RouteState>('api_route_state', { connection, domain, route })
}

export function apiRouteAction(
  connection: Connection,
  domain: string,
  route: string,
  action: RouteAction,
): Promise<void> {
  return invoke<void>('api_route_action', { connection, domain, route, action })
}

export function apiSavePoints(connection: Connection): Promise<SavePoint[]> {
  return invoke<SavePoint[]>('api_save_points', { connection })
}

export function apiCreateSavePoint(connection: Connection): Promise<void> {
  return invoke<void>('api_create_save_point', { connection })
}

export function apiDeleteSavePoint(connection: Connection, point: SavePoint): Promise<void> {
  return invoke<void>('api_delete_save_point', { connection, point })
}

export function apiRollbackSavePoint(connection: Connection, point: SavePoint): Promise<void> {
  return invoke<void>('api_rollback_save_point', { connection, point })
}

export function apiQueueManagers(connection: Connection): Promise<QueueManager[]> {
  return invoke<QueueManager[]>('api_queue_managers', { connection })
}

export function apiQueues(connection: Connection, kind: ManagerKind, id: string): Promise<QueueRow[]> {
  return invoke<QueueRow[]>('api_queues', { connection, kind, id })
}

/** Сообщения очереди — без тела: его шина отдаёт только поштучно. */
export function apiQueueMessages(
  connection: Connection,
  kind: ManagerKind,
  id: string,
  queue: string,
  limit: number,
): Promise<QueueMessage[]> {
  return invoke<QueueMessage[]>('api_queue_messages', { connection, kind, id, queue, limit })
}

export function apiQueueMessage(
  connection: Connection,
  kind: ManagerKind,
  id: string,
  queue: string,
  message: string,
): Promise<QueueMessage> {
  return invoke<QueueMessage>('api_queue_message', { connection, kind, id, queue, message })
}

/**
 * Ищет текст в телах сообщений очереди.
 *
 * Тела в списке нет, поэтому каждое сообщение читается отдельным запросом —
 * поиск идёт по кнопке, а не по каждому нажатию клавиши. Прогресс приходит
 * теми же событиями, что у выгрузки доменов.
 */
export function apiQueueSearch(
  connection: Connection,
  kind: ManagerKind,
  id: string,
  queue: string,
  ids: string[],
  needle: string,
): Promise<QueueMatch[]> {
  return invoke<QueueMatch[]>('api_queue_search', { connection, kind, id, queue, ids, needle })
}

export function apiProperties(connection: Connection, scope: PropertyScope): Promise<PropertyRow[]> {
  return invoke<PropertyRow[]>('api_properties', { connection, scope })
}

/** Чем один стенд отличается от другого. Оба опрашиваются только на чтение. */
export function apiCompareStands(left: Connection, right: Connection): Promise<Comparison> {
  return invoke<Comparison>('api_compare_stands', { left, right })
}

/** Константы всех уровней разом: ход работы идёт событиями `api:progress`. */
export function apiPropertiesSweep(connection: Connection): Promise<SweepRow[]> {
  return invoke<SweepRow[]>('api_properties_sweep', { connection })
}

export function apiSaveProperty(
  connection: Connection,
  scope: PropertyScope,
  property: PropertyRow,
  create: boolean,
  /** Попадает в историю изменений шины: по нему потом видно, чья это правка. */
  comment?: string,
): Promise<void> {
  return invoke<void>('api_save_property', { connection, scope, property, create, comment: comment ?? null })
}

export function apiDeleteProperty(connection: Connection, scope: PropertyScope, key: string): Promise<void> {
  return invoke<void>('api_delete_property', { connection, scope, key })
}

export function apiLogFiles(connection: Connection): Promise<LogFileRow[]> {
  return invoke<LogFileRow[]>('api_log_files', { connection })
}

export function apiLog(connection: Connection, request: LogRequest): Promise<LogEntry[]> {
  return invoke<LogEntry[]>('api_log', { connection, request })
}

/** Журнал аудита, разобранный на пользователя, действие и результат. */
export function apiAudit(connection: Connection, request: LogRequest): Promise<AuditEntry[]> {
  return invoke<AuditEntry[]>('api_audit', { connection, request })
}

export { errorText } from './errors'
