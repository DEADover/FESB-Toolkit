import { useCallback, useEffect, useState } from 'react'

import { Sidebar, type ScreenId } from './components/Sidebar'
import { TraceScreen } from './components/TraceScreen'
import { Badge, Button, Spinner, cx } from './components/ui'
import { useI18n } from './i18n'
import {
  appInfo, errorText, onExtractProgress, onFileDrop, onScanProgress,
  openArchive, scanDirectory, selectArchive, selectFolder,
} from './lib/api'
import { applyThemeMode, readThemeMode, storeThemeMode, type ThemeMode } from './lib/theme'
import type { AppInfo, ArchiveProgress, ScanProgress, ScanResult } from './types'

/** Откуда взята конфигурация: из папки или из распакованного архива. */
interface Source {
  kind: 'folder' | 'archive'
  path: string
}

export default function App() {
  const { t } = useI18n()

  const [info, setInfo] = useState<AppInfo | null>(null)
  const [screen, setScreen] = useState<ScreenId>('files.trace')
  const [themeMode, setThemeMode] = useState<ThemeMode>(readThemeMode)

  const [source, setSource] = useState<Source | null>(null)
  const [root, setRoot] = useState<string | null>(null)
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [unpacking, setUnpacking] = useState(false)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [extractProgress, setExtractProgress] = useState<ArchiveProgress | null>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isMac = info?.platform === 'macos'
  const busy = scanning || unpacking

  useEffect(() => { appInfo().then(setInfo).catch(() => setInfo(null)) }, [])

  useEffect(() => {
    const scanUnlisten = onScanProgress(setProgress)
    const extractUnlisten = onExtractProgress(setExtractProgress)
    return () => {
      scanUnlisten.then((off) => off())
      extractUnlisten.then((off) => off())
    }
  }, [])

  // Режим «системная тема» должен следовать за настройкой ОС на лету.
  useEffect(() => {
    applyThemeMode(themeMode)
    if (themeMode !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyThemeMode('system')
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [themeMode])

  const changeTheme = useCallback((mode: ThemeMode) => {
    storeThemeMode(mode)
    setThemeMode(mode)
  }, [])

  const runScan = useCallback(async (path: string) => {
    setScanning(true)
    setError(null)
    setProgress(null)
    try {
      const result = await scanDirectory(path)
      setScan(result)
      setRoot(result.root)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setScanning(false)
      setProgress(null)
    }
  }, [])

  /** Открывает путь: архив сначала распаковывается во временную папку. */
  const openPath = useCallback(async (path: string) => {
    if (path.toLowerCase().endsWith('.zip')) {
      setUnpacking(true)
      setError(null)
      setExtractProgress(null)
      try {
        const extracted = await openArchive(path)
        setSource({ kind: 'archive', path })
        await runScan(extracted.root)
      } catch (err) {
        setError(errorText(err))
      } finally {
        setUnpacking(false)
        setExtractProgress(null)
      }
      return
    }
    setSource({ kind: 'folder', path })
    await runScan(path)
  }, [runScan])

  const pickFolder = useCallback(async () => {
    const path = await selectFolder(t('dialog.selectFolder'))
    if (path) await openPath(path)
  }, [openPath, t])

  const pickArchive = useCallback(async () => {
    const path = await selectArchive(t('dialog.openArchive'))
    if (path) await openPath(path)
  }, [openPath, t])

  const rescan = useCallback(async () => { if (root) await runScan(root) }, [root, runScan])

  // Перетаскивание работает на любом экране: папка или архив открываются сразу.
  useEffect(() => {
    const unlisten = onFileDrop((paths) => {
      const path = paths[0]
      if (path) void openPath(path)
    }, setDragging)
    return () => { unlisten.then((off) => off()) }
  }, [openPath])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey
      if (!meta) return
      if (event.key.toLowerCase() === 'o') {
        event.preventDefault()
        void pickFolder()
      }
      if (event.key.toLowerCase() === 'r' && root) {
        event.preventDefault()
        void rescan()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pickFolder, rescan, root])

  const isApiScreen = screen.startsWith('api.')
  const sourceLabel = source?.kind === 'archive' ? t('header.archive') : t('header.folder')

  return (
    <div className="relative flex h-full">
      <Sidebar
        screen={screen}
        onScreen={setScreen}
        info={info}
        isMac={isMac}
        themeMode={themeMode}
        onThemeMode={changeTheme}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header data-tauri-drag-region className={cx('flex items-center gap-3 px-6 pb-4', isMac ? 'pt-9' : 'pt-4')}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-[15px] font-semibold leading-tight">
                {isApiScreen ? t('nav.api') : t('header.trace')}
              </h1>
              {scan?.fesbVersion && (
                <Badge tone="accent" className="font-mono">
                  <span title={t('header.fesbVersion')}>FESB {scan.fesbVersion}</span>
                </Badge>
              )}
            </div>
            <p className="truncate text-[11.5px] text-content-subtle" title={source?.path}>
              {source ? `${sourceLabel}: ${source.path}` : t('header.noFolder')}
              {scan && ` · ${t('stats.domains')}: ${scan.domains.length}`}
            </p>
          </div>
          {!isApiScreen && root && (
            <Button onClick={rescan} disabled={busy}>
              {scanning ? <Spinner className="size-4" /> : '↻'} {t('action.refresh')}
            </Button>
          )}
          {!isApiScreen && (
            <>
              <Button onClick={pickArchive} disabled={busy}>{t('action.openArchive')}</Button>
              <Button variant="primary" onClick={pickFolder} disabled={busy}>{t('action.selectFolder')}</Button>
            </>
          )}
        </header>

        {isApiScreen ? (
          <Placeholder />
        ) : !scan ? (
          <EmptyState
            busy={busy}
            unpacking={unpacking}
            progress={progress}
            extractProgress={extractProgress}
            onPickFolder={pickFolder}
            onPickArchive={pickArchive}
            error={error}
          />
        ) : (
          <TraceScreen scan={scan} isMac={isMac} sourcePath={source?.path ?? null} onRescan={rescan} />
        )}
      </main>

      {dragging && <DropOverlay />}
    </div>
  )
}

/** Подсказка поверх окна, пока над ним держат файл. */
function DropOverlay() {
  const { t } = useI18n()
  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-canvas/80 backdrop-blur-sm">
      <div className="rounded-2xl border-2 border-dashed border-accent bg-surface px-10 py-8 text-center shadow-2xl">
        <div className="text-[28px]">⤓</div>
        <div className="mt-2 text-[15px] font-semibold">{t('empty.dropHere')}</div>
      </div>
    </div>
  )
}

function EmptyState({ busy, unpacking, progress, extractProgress, onPickFolder, onPickArchive, error }: {
  busy: boolean
  unpacking: boolean
  progress: ScanProgress | null
  extractProgress: ArchiveProgress | null
  onPickFolder: () => void
  onPickArchive: () => void
  error: string | null
}) {
  const { t } = useI18n()
  return (
    <div className="flex flex-1 items-center justify-center px-6 pb-10">
      <div className="w-full max-w-xl rounded-2xl border border-dashed border-line-strong bg-surface/60 px-8 py-10 text-center">
        {busy ? (
          <>
            <Spinner className="mx-auto size-8 text-accent-content" />
            <h2 className="mt-4 text-[15px] font-semibold">
              {unpacking ? t('empty.unpacking') : t('empty.scanning')}
            </h2>
            <p className="mt-1 text-content-subtle">
              {unpacking
                ? t('empty.progress.files', { current: extractProgress?.current ?? 0, total: extractProgress?.total ?? 0 })
                : progress?.phase === 'read'
                  ? t('empty.progress.read', { current: progress.current, total: progress.total })
                  : t('empty.progress.walk', { visited: progress?.visited ?? 0, found: progress?.found ?? 0 })}
            </p>
          </>
        ) : (
          <>
            <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-surface-2 text-[22px] text-accent-content">⤓</div>
            <h2 className="mt-4 text-[15px] font-semibold">{t('empty.title')}</h2>
            <p className="mx-auto mt-2 max-w-md text-content-subtle">{t('empty.text')}</p>

            {/* Самая частая ошибка — выбрать саму папку domains, поэтому показываем структуру. */}
            <div className="mx-auto mt-5 max-w-md rounded-xl border border-caution/30 bg-caution/8 px-4 py-3 text-left">
              <p className="text-[11.5px] text-caution">{t('empty.layout')}</p>
              <pre className="mt-2 font-mono text-[11.5px] leading-relaxed text-content-muted">{`config-2026-08-24T20-58 (8.6)
├── domains/
└── version`}</pre>
            </div>

            <div className="mt-6 flex items-center justify-center gap-2">
              <Button variant="primary" onClick={onPickFolder}>{t('action.selectFolder')}</Button>
              <Button onClick={onPickArchive}>{t('action.openArchive')}</Button>
            </div>
            {error && <p className="mt-4 rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-negative">{error}</p>}
          </>
        )}
      </div>
    </div>
  )
}

function Placeholder() {
  const { t } = useI18n()
  return (
    <div className="flex flex-1 items-center justify-center px-6 pb-10">
      <div className="max-w-md text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-surface-2 text-[22px] text-accent-content">⇄</div>
        <h2 className="mt-4 text-[15px] font-semibold">{t('soon.title')}</h2>
        <p className="mt-2 text-content-subtle">{t('soon.text')}</p>
      </div>
    </div>
  )
}
