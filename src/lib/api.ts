import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open, save } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'

import type {
  AppInfo, ApplyProgress, ApplyReport, ApplyTarget, ArchiveProgress, ArchiveResult,
  ExtractResult, ScanProgress, ScanResult, TraceUpdate,
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

/** Понятный текст для ошибки, прилетевшей из команды Tauri. */
export function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return JSON.stringify(error)
}
