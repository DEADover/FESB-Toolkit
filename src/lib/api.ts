import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open, save } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'

import type {
  ApiDomain, ApiProgress, AppInfo, ApplyProgress, ApplyReport, ApplyTarget, ArchiveProgress,
  ArchiveResult, Connection, ExtractResult, LogEntry, LogFileRow, LogRequest, ManagerKind,
  ModuleAction, ModuleRow, PropertyRow, PropertyScope, PullResult, PushResult, QueueManager,
  QueueRow, ScanProgress, ScanResult, ServerInfo, TraceUpdate,
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

export function apiQueueManagers(connection: Connection): Promise<QueueManager[]> {
  return invoke<QueueManager[]>('api_queue_managers', { connection })
}

export function apiQueues(connection: Connection, kind: ManagerKind, id: string): Promise<QueueRow[]> {
  return invoke<QueueRow[]>('api_queues', { connection, kind, id })
}

/** Бэкенд ждёт `Application`, `Broker` или `{ Domain: guid }`. */
function scopePayload(scope: PropertyScope): unknown {
  if (scope === 'application') return 'Application'
  if (scope === 'broker') return 'Broker'
  return { Domain: scope.domain }
}

export function apiProperties(connection: Connection, scope: PropertyScope): Promise<PropertyRow[]> {
  return invoke<PropertyRow[]>('api_properties', { connection, scope: scopePayload(scope) })
}

export function apiSaveProperty(
  connection: Connection,
  scope: PropertyScope,
  property: PropertyRow,
  create: boolean,
): Promise<void> {
  return invoke<void>('api_save_property', { connection, scope: scopePayload(scope), property, create })
}

export function apiDeleteProperty(connection: Connection, scope: PropertyScope, key: string): Promise<void> {
  return invoke<void>('api_delete_property', { connection, scope: scopePayload(scope), key })
}

export function apiLogFiles(connection: Connection): Promise<LogFileRow[]> {
  return invoke<LogFileRow[]>('api_log_files', { connection })
}

export function apiLog(connection: Connection, request: LogRequest): Promise<LogEntry[]> {
  return invoke<LogEntry[]>('api_log', { connection, request })
}

/** Понятный текст для ошибки, прилетевшей из команды Tauri. */
export function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return JSON.stringify(error)
}
