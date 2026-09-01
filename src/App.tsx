import { useCallback, useEffect, useRef, useState } from 'react'

import { ArrowsClockwise, DownloadSimple } from '@phosphor-icons/react'

import { AuditScreen } from './components/AuditScreen'
import { ConnectionScreen } from './components/ConnectionScreen'
import { DomainLinksScreen } from './components/DomainLinksScreen'
import { ServerSwitch } from './components/HeaderBar'
import { DomainsScreen, type PullIntent } from './components/DomainsScreen'
import { WelcomeScreen } from './components/WelcomeScreen'
import { AccessScreen } from './components/AccessScreen'
import { CertificatesScreen } from './components/CertificatesScreen'
import { EndpointsScreen } from './components/EndpointsScreen'
import { InflightScreen } from './components/InflightScreen'
import { TracingScreen } from './components/TracingScreen'
import { LogsScreen } from './components/LogsScreen'
import { ModulesScreen } from './components/ModulesScreen'
import { PropertiesScreen } from './components/PropertiesScreen'
import { QueuesScreen } from './components/QueuesScreen'
import { RoutesScreen } from './components/RoutesScreen'
import { Sidebar, type ScreenId } from './components/Sidebar'
import { TraceScreen } from './components/TraceScreen'
import { CommandPalette } from './components/CommandPalette'
import { useToast } from './components/Toaster'
import { Badge, Button, ButtonGlyph, cx, Notice, Spinner } from './components/ui'
import { useI18n, type MessageKey } from './i18n'
import {
  apiConnect, apiPull, appInfo, buildArchive, errorText, onApiProgress, onExtractProgress, onFileDrop, onScanProgress, openArchive, saveZipAs, scanDirectory, selectArchive, selectFolder,
} from './lib/api'
import {
  autoConnectTarget, markUsed, readStore, toConnection, writeStore,
  type ConnectionProfile, type ConnectionStore,
} from './lib/connection'
import { localStamp } from './lib/paths'
import { applyThemeMode, readThemeMode, storeThemeMode, type ThemeMode } from './lib/theme'
import type {
  ApiProgress, AppInfo, ArchiveProgress, Connection, ScanProgress, ScanResult, ServerInfo,
} from './types'

const SIDEBAR_KEY = 'fesb.sidebar'

/** Откуда взята конфигурация: папка, распакованный архив или сервер. */
interface Source {
  kind: 'folder' | 'archive' | 'server'
  path: string
}

/** Подтверждённое подключение: сервер, параметры и профиль, которым он открыт. */
interface Session {
  server: ServerInfo
  connection: Connection
  profile: ConnectionProfile
}

export default function App() {
  const { t } = useI18n()
  const toast = useToast()

  const [info, setInfo] = useState<AppInfo | null>(null)
  const [screen, setScreen] = useState<ScreenId>('welcome')
  const [themeMode, setThemeMode] = useState<ThemeMode>(readThemeMode)
  const [sidebarHidden, setSidebarHidden] = useState(() => localStorage.getItem(SIDEBAR_KEY) === 'hidden')

  const [source, setSource] = useState<Source | null>(null)
  const [root, setRoot] = useState<string | null>(null)
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [unpacking, setUnpacking] = useState(false)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [extractProgress, setExtractProgress] = useState<ArchiveProgress | null>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [connections, setConnections] = useState<ConnectionStore>(readStore)
  const [session, setSession] = useState<Session | null>(null)
  const [pulling, setPulling] = useState(false)
  const [apiProgress, setApiProgress] = useState<ApiProgress | null>(null)
  const [pullError, setPullError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  /** Последнее переключение стенда не удалось: точка в пилюле красная. */
  const [failedSwitch, setFailedSwitch] = useState(false)
  /** Профиль, который надо раскрыть на экране подключения. */
  const [focusProfile, setFocusProfile] = useState<string | null>(null)
  /** Домен, к СОПС которого перешли с карты. */
  const [routesDomain, setRoutesDomain] = useState<string | null>(null)

  const isMac = info?.platform === 'macos'
  const busy = scanning || unpacking

  useEffect(() => { appInfo().then(setInfo).catch(() => setInfo(null)) }, [])

  useEffect(() => {
    const scanUnlisten = onScanProgress(setProgress)
    const extractUnlisten = onExtractProgress(setExtractProgress)
    const apiUnlisten = onApiProgress(setApiProgress)
    return () => {
      scanUnlisten.then((off) => off())
      extractUnlisten.then((off) => off())
      apiUnlisten.then((off) => off())
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

  const toggleSidebar = useCallback(() => {
    setSidebarHidden((prev) => {
      localStorage.setItem(SIDEBAR_KEY, prev ? 'shown' : 'hidden')
      return !prev
    })
  }, [])

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

  /** Открывает подключение по профилю; ошибку разбирает вызывающий экран. */
  const connectProfile = useCallback(async (profile: ConnectionProfile) => {
    setConnecting(true)
    try {
      const server = await apiConnect(toConnection(profile))
      // Адрес мог быть введён без схемы и без /manager: подключение подобрало
      // рабочий вариант, и дальше все вызовы идут уже по нему, без перебора.
      const connection = { ...toConnection(profile), url: server.baseUrl }
      setSession({ server, connection, profile })
      setConnections((prev) => {
        const next = markUsed(prev, profile.id, new Date().toISOString())
        writeStore(next)
        return next
      })
    } finally {
      setConnecting(false)
    }
  }, [])

  const disconnect = useCallback(() => { setSession(null); setFailedSwitch(false) }, [])

  const configure = useCallback((profileId: string | null) => {
    setFocusProfile(profileId)
    setScreen('api.connection')
  }, [])

  /**
   * Переключение стенда из шапки.
   *
   * Раньше ошибка здесь просто пропадала: нажимаешь другой стенд, ничего
   * не происходит, и почему — неизвестно. Теперь неудача остаётся на виду
   * до следующей попытки, вместе с именем стенда и дорогой к его настройкам.
   */
  const switchProfile = useCallback((profile: ConnectionProfile) => {
    setFailedSwitch(false)
    void connectProfile(profile).catch((error: unknown) => {
      setFailedSwitch(true)
      toast({
        tone: 'danger',
        title: t('switch.failed', { name: profile.name }),
        text: errorText(error),
        action: { label: t('switch.configure'), onClick: () => configure(profile.id) },
      })
    })
  }, [connectProfile, toast, t, configure])


  // Автоподключение возможно только к профилю с сохранённым паролем.
  const autoConnected = useRef(false)
  useEffect(() => {
    if (autoConnected.current) return
    const target = autoConnectTarget(connections)
    if (!target) return
    autoConnected.current = true
    // Тот же путь, что и у ручного подключения: результат попадёт в журнал.
    void connectProfile(target).catch(() => {})
    // Автоподключение — разовое действие при запуске, а не реакция на правку профилей.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Забирает домены с сервера.
   *
   * Выгрузка одна и та же, различается только то, что происходит потом:
   * либо домены открываются в редакторе, либо сразу складываются в архив.
   * Второй случай раньше приходилось доводить вручную через редактор.
   */
  const pull = useCallback(async (guids: string[] | null, intent: PullIntent) => {
    if (!session) return
    setPulling(true)
    setPullError(null)
    setApiProgress(null)
    try {
      const result = await apiPull(session.connection, guids)
      if (intent === 'archive') {
        const output = await saveZipAs(t('dialog.saveZip'), `config-${localStamp()}.zip`)
        if (output) await buildArchive(result.root, output, null)
        return
      }
      setSource({ kind: 'server', path: session.server.baseUrl })
      await runScan(result.root)
      setScreen('files.trace')
    } catch (err) {
      setPullError(errorText(err))
    } finally {
      setPulling(false)
      setApiProgress(null)
    }
  }, [session, runScan, t])

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
      // Разделов шестнадцать, и до нужного мышью дольше, чем набрать имя.
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pickFolder, rescan, root])

  const isApiScreen = screen.startsWith('api.')
  const isLinksScreen = screen === 'files.links'
  // На первом экране кнопки шапки не нужны: те же действия стоят карточками
  // в самом экране, и дублировать их — только сбивать с толку.
  const isWelcome = screen === 'welcome'
  const apiScreenProps = {
    connection: session?.connection ?? null,
    server: session?.server ?? null,
    onGoToConnection: () => setScreen('api.connection'),
  }
  const sourceLabel = source?.kind === 'archive'
    ? t('header.archive')
    : source?.kind === 'server' ? t('header.server') : t('header.folder')
  const API_TITLES: Partial<Record<ScreenId, MessageKey>> = {
    'api.connection': 'nav.api.connection.title',
    'api.domains': 'nav.api.domains.title',
    'files.links': 'nav.files.links.title',
    'api.audit': 'nav.api.audit.title',
    'api.access': 'nav.api.access.title',
    'api.routes': 'nav.api.routes.title',
    'api.endpoints': 'nav.api.endpoints.title',
    'api.certificates': 'nav.api.certificates.title',
    'api.inflight': 'nav.api.inflight.title',
    'api.tracing': 'nav.api.tracing.title',
    welcome: 'nav.welcome',
    'api.queues': 'nav.api.queues.title',
    'api.modules': 'nav.api.modules.title',
    'api.properties': 'nav.api.properties.title',
    'api.logs': 'nav.api.logs.title',
  }
  const screenTitle = t(API_TITLES[screen] ?? 'nav.files.trace')

  return (
    <div className="relative flex h-full">
      <Sidebar
        screen={screen}
        onScreen={setScreen}
        info={info}
        isMac={isMac}
        collapsed={sidebarHidden}
        onCollapse={toggleSidebar}
        themeMode={themeMode}
        onThemeMode={changeTheme}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {/* Шапка в две строки: сверху заголовок и действия над результатом,
            снизу — чем сменить конфигурацию. Заголовок с адресом занимает
            ровно ту же высоту, что и кнопки справа, поэтому они стоят
            на одной линии, а не плавают друг относительно друга. */}
        <header data-tauri-drag-region className={cx('flex flex-col gap-2 px-6 pb-4', isMac ? 'pt-9' : 'pt-4')}>
          <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-48 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-[15px] font-semibold leading-tight">{screenTitle}</h1>
              {scan?.fesbVersion && !isApiScreen && !isWelcome && (
                <Badge tone="accent" className="font-mono">
                  <span title={t('header.fesbVersion')}>FESB {scan.fesbVersion}</span>
                </Badge>
              )}
            </div>
            {/*
              Имя стенда, адрес и пользователь живут в пилюле подключения справа —
              в подзаголовке остаётся только то, чего там нет: откуда взята
              конфигурация в файловом режиме.
            */}
            {!isApiScreen && !isLinksScreen && !isWelcome && (
              <p className="truncate text-[11.5px] text-content-subtle" title={source?.path}>
                {source
                  ? source.kind === 'server'
                    ? `${sourceLabel}${scan ? ` · ${t('stats.domains')}: ${scan.domains.length}` : ''}`
                    : `${sourceLabel}: ${source.path}${scan ? ` · ${t('stats.domains')}: ${scan.domains.length}` : ''}`
                  : t('header.noFolder')}
              </p>
            )}
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <ServerSwitch
            store={connections}
            active={session?.profile ?? null}
            server={session?.server ?? null}
            connecting={connecting}
            failed={failedSwitch}
            onConnect={switchProfile}
            onDisconnect={disconnect}
            onConfigure={configure}
          />
          {/* Два места для действий экрана: серверные встают рядом
              с переключателем стенда, работа с архивом — рядом с «Open ZIP».
              Наполняет их сам экран через `HeaderActions`. */}
          <div id="header-actions-server" className="flex items-center gap-2 empty:hidden" />
          <div id="header-actions-files" className="flex items-center gap-2 empty:hidden" />
          </div>
          </div>

          {/* Чем сменить конфигурацию — своей строкой под адресом. Наверху
              они спорили за место с действиями над результатом, а в строке
              адреса ссылками терялись: «Выбрать папку» ищут глазами. */}
          {!isApiScreen && !isLinksScreen && !isWelcome && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={pickFolder} disabled={busy}>{t('action.selectFolder')}</Button>
              <Button size="sm" onClick={pickArchive} disabled={busy}>{t('action.openArchive')}</Button>
              {root && (
                <Button size="sm" onClick={rescan} disabled={busy || scanning}>
                  <ButtonGlyph busy={scanning}><ArrowsClockwise size={13} weight="bold" /></ButtonGlyph>
                  {t('action.refresh')}
                </Button>
              )}
            </div>
          )}
        </header>

        {screen === 'welcome' ? (
          <WelcomeScreen
            server={session?.server ?? null}
            connection={session?.connection ?? null}
            scan={scan}
            sourcePath={source?.path ?? null}
            connections={connections}
            connecting={connecting}
            onScreen={setScreen}
            onOpenFolder={pickFolder}
            onOpenArchive={pickArchive}
            onConnect={switchProfile}
          />
        ) : screen === 'api.connection' ? (
          <ConnectionScreen
            store={connections}
            onStore={setConnections}
            server={session?.server ?? null}
            connection={session?.connection ?? null}
            activeProfileId={session?.profile.id ?? null}
            focusProfileId={focusProfile}
            onConnect={connectProfile}
            onDisconnect={disconnect}
          />
        ) : screen === 'api.domains' ? (
          <DomainsScreen
            connection={session?.connection ?? null}
            server={session?.server ?? null}
            pulling={pulling}
            progress={apiProgress}
            error={pullError}
            onPull={pull}
            onOpenRoutes={(guid) => { setRoutesDomain(guid); setScreen('api.routes') }}
            onGoToLogs={() => setScreen('api.logs')}
            onGoToConnection={() => setScreen('api.connection')}
          />
        ) : screen === 'api.routes' ? (
          <RoutesScreen {...apiScreenProps} isMac={isMac} initialGuid={routesDomain} />
        ) : screen === 'api.tracing' ? (
          <TracingScreen
            {...apiScreenProps}
            onOpenRoutes={(guid) => { setRoutesDomain(guid); setScreen('api.routes') }}
          />
        ) : screen === 'api.inflight' ? (
          <InflightScreen
            {...apiScreenProps}
            onOpenRoutes={(guid) => { setRoutesDomain(guid); setScreen('api.routes') }}
          />
        ) : screen === 'api.endpoints' ? (
          <EndpointsScreen {...apiScreenProps} />
        ) : screen === 'api.certificates' ? (
          <CertificatesScreen {...apiScreenProps} />
        ) : screen === 'api.queues' ? (
          <QueuesScreen {...apiScreenProps} />
        ) : screen === 'api.modules' ? (
          <ModulesScreen {...apiScreenProps} />
        ) : screen === 'api.properties' ? (
          <PropertiesScreen {...apiScreenProps} />
        ) : screen === 'api.logs' ? (
          <LogsScreen {...apiScreenProps} />
        ) : screen === 'api.audit' ? (
          <AuditScreen {...apiScreenProps} />
        ) : screen === 'api.access' ? (
          <AccessScreen {...apiScreenProps} />
        ) : isLinksScreen ? (
          <DomainLinksScreen
            scan={scan}
            isMac={isMac}
            onOpenFolder={pickFolder}
            onGoToDomains={() => setScreen('api.domains')}
          />
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
          <TraceScreen
            scan={scan}
            isMac={isMac}
            sourcePath={source?.path ?? null}
            server={source?.kind === 'server' ? session : null}
            onRescan={rescan}
          />
        )}
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        store={connections}
        onScreen={setScreen}
        onConnect={switchProfile}
        onConfigure={configure}
      />

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
        <DownloadSimple size={28} weight="regular" className="mx-auto" />
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
            <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-surface-2 text-accent-content"><DownloadSimple size={24} weight="regular" /></div>
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
            {error && <Notice tone="danger" className="mt-4">{error}</Notice>}
          </>
        )}
      </div>
    </div>
  )
}
