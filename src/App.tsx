import { useCallback, useEffect, useState } from 'react'

import { Sidebar, type ScreenId } from './components/Sidebar'
import { TraceScreen } from './components/TraceScreen'
import { Badge, Button, Spinner, cx } from './components/ui'
import { useI18n } from './i18n'
import { appInfo, errorText, onScanProgress, scanDirectory, selectFolder } from './lib/api'
import { applyThemeMode, readThemeMode, storeThemeMode, type ThemeMode } from './lib/theme'
import type { AppInfo, ScanProgress, ScanResult } from './types'

export default function App() {
  const { t } = useI18n()

  const [info, setInfo] = useState<AppInfo | null>(null)
  const [screen, setScreen] = useState<ScreenId>('files.trace')
  const [themeMode, setThemeMode] = useState<ThemeMode>(readThemeMode)

  const [root, setRoot] = useState<string | null>(null)
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isMac = info?.platform === 'macos'

  useEffect(() => { appInfo().then(setInfo).catch(() => setInfo(null)) }, [])

  useEffect(() => {
    const unlisten = onScanProgress(setProgress)
    return () => { unlisten.then((off) => off()) }
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

  const pickFolder = useCallback(async () => {
    const path = await selectFolder(t('dialog.selectFolder'))
    if (path) await runScan(path)
  }, [runScan, t])

  const rescan = useCallback(async () => { if (root) await runScan(root) }, [root, runScan])

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

  return (
    <div className="flex h-full">
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
                <Badge tone="accent" className="font-mono" >
                  <span title={t('header.fesbVersion')}>FESB {scan.fesbVersion}</span>
                </Badge>
              )}
            </div>
            <p className="truncate text-[11.5px] text-content-subtle" title={root ?? undefined}>
              {root ? `${t('header.folder')}: ${root}` : t('header.noFolder')}
              {scan && ` · ${t('stats.domains')}: ${scan.domains.length}`}
            </p>
          </div>
          {!isApiScreen && root && (
            <Button onClick={rescan} disabled={scanning}>
              {scanning ? <Spinner className="size-4" /> : '↻'} {t('action.refresh')}
            </Button>
          )}
          {!isApiScreen && (
            <Button variant="primary" onClick={pickFolder} disabled={scanning}>{t('action.selectFolder')}</Button>
          )}
        </header>

        {isApiScreen ? (
          <Placeholder />
        ) : !scan ? (
          <EmptyState scanning={scanning} progress={progress} onPick={pickFolder} error={error} />
        ) : (
          <TraceScreen scan={scan} isMac={isMac} onRescan={rescan} />
        )}
      </main>
    </div>
  )
}

function EmptyState({ scanning, progress, onPick, error }: {
  scanning: boolean
  progress: ScanProgress | null
  onPick: () => void
  error: string | null
}) {
  const { t } = useI18n()
  return (
    <div className="flex flex-1 items-center justify-center px-6 pb-10">
      <div className="w-full max-w-lg rounded-2xl border border-dashed border-line-strong bg-surface/60 px-8 py-12 text-center">
        {scanning ? (
          <>
            <Spinner className="mx-auto size-8 text-accent-content" />
            <h2 className="mt-4 text-[15px] font-semibold">{t('empty.scanning')}</h2>
            <p className="mt-1 text-content-subtle">
              {progress?.phase === 'read'
                ? t('empty.progress.read', { current: progress.current, total: progress.total })
                : t('empty.progress.walk', { visited: progress?.visited ?? 0, found: progress?.found ?? 0 })}
            </p>
          </>
        ) : (
          <>
            <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-surface-2 text-[22px] text-accent-content">▤</div>
            <h2 className="mt-4 text-[15px] font-semibold">{t('empty.title')}</h2>
            <p className="mx-auto mt-2 max-w-sm text-content-subtle">{t('empty.text')}</p>
            <Button variant="primary" className="mt-6" onClick={onPick}>{t('action.selectFolder')}</Button>
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
