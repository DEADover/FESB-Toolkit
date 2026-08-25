export interface TraceBean {
  beanId: string | null
  beanName: string | null
  broker: string | null
  queue: string | null
  clientType: string | null
  traceMode: string | null
  line: number
  /** У bean-а есть соответствующий property — значит значение можно заменить. */
  brokerEditable: boolean
  queueEditable: boolean
  traceModeEditable: boolean
}

/** СОПС — схема обработки потоков сообщений, она же route Apache Camel. */
export interface RouteInfo {
  id: string | null
  name: string | null
  traceEnabled: boolean
  /** Имена bean-ов трассировки, на которые ссылается маршрут. */
  traceConfigs: string[]
  inlineTraceConfig: boolean
  file: string
}

export interface DomainRecord {
  id: string
  dirPath: string
  dirName: string
  domainXmlPath: string
  settingsPath: string | null
  domainName: string
  guid: string | null
  description: string | null
  startActive: boolean | null
  startMode: string | null
  hidden: boolean | null
  traces: TraceBean[]
  routes: RouteInfo[]
  errors: string[]
}

export interface ScanResult {
  root: string
  /** Версия шины из файла `version` рядом с выгрузкой, например `V8.6.461`. */
  fesbVersion: string | null
  scannedAt: string
  durationMs: number
  domains: DomainRecord[]
}

export type TraceField = 'broker' | 'queue' | 'traceMode'

/** Пустое поле означает «не трогать». */
export interface TraceUpdate {
  broker: string | null
  queue: string | null
  traceMode: string | null
}

export interface ApplyTargetBean {
  beanId: string | null
  beanName: string | null
  expectedBroker: string | null
  expectedQueue: string | null
  expectedTraceMode: string | null
}

export interface ApplyTarget {
  domainXmlPath: string
  domainName: string
  beans: ApplyTargetBean[]
}

export interface FieldChange {
  field: TraceField
  from: string | null
  to: string
  line: number
}

export interface ApplyChange {
  beanId: string | null
  beanName: string | null
  fields: FieldChange[]
}

export type SkipReason = 'bean-not-found' | 'property-not-found' | 'value-changed' | 'already-set'

export interface ApplySkip {
  beanId: string | null
  beanName: string | null
  field: TraceField | null
  reason: SkipReason
  actual: string | null
}

export interface ApplyFileResult {
  domainXmlPath: string
  domainName: string | null
  status: 'ok' | 'skipped' | 'error'
  changed: ApplyChange[]
  skipped: ApplySkip[]
  backupPath: string | null
  error: string | null
}

export interface ApplyReport {
  summary: {
    broker: string | null
    queue: string | null
    traceMode: string | null
    dryRun: boolean
    total: number
    ok: number
    skipped: number
    failed: number
    beansChanged: number
    valuesChanged: number
    finishedAt: string
  }
  results: ApplyFileResult[]
}

export interface ArchiveResult {
  path: string
  /** Сколько папок доменов вошло в архив. */
  domains: number
  files: number
  bytes: number
  /** Сколько файлов `.bak` намеренно не попало в архив. */
  skippedBackups: number
  hasVersion: boolean
}

export interface ExtractResult {
  /** Папка, из которой дальше работает приложение. */
  root: string
  files: number
  hasVersion: boolean
}

export interface ArchiveProgress {
  current: number
  total: number
}

export interface ScanProgress {
  phase: 'walk' | 'read'
  visited: number
  found: number
  current: number
  total: number
}

export interface ApplyProgress {
  current: number
  total: number
  domainName: string | null
}

export interface AppInfo {
  version: string
  tauri: string
  platform: string
}

// ───────────────────────────── режим API ─────────────────────────────

export interface Connection {
  url: string
  username: string
  password: string
  /** Принимать самоподписанные сертификаты. */
  insecure: boolean
}

export interface ModuleState {
  name: string
  label: string
  active: boolean
  running: boolean
}

export interface ServerInfo {
  /** Адрес в том виде, в котором к нему обращается приложение. */
  baseUrl: string
  user: string
  roles: string[]
  permissions: number
  /** Права, которых не хватает для цикла «забрать → отправить». */
  missingPermissions: string[]
  apiVersion: string | null
  domains: number
  activeDomains: number
  modules: ModuleState[]
  checkedAt: string
}

export interface ApiDomain {
  guid: string
  name: string
  active: boolean
  leader: boolean
  clustered: boolean
  group: string | null
  tags: string[]
}

export interface PullResult {
  root: string
  domains: number
  files: number
  bytes: number
  hasVersion: boolean
}

export interface PushResult {
  domains: string[]
  files: number
  bytes: number
  reloaded: boolean
  message: string | null
  finishedAt: string
}

export interface ApiProgress {
  /** `domains` при выгрузке, `pack` и `upload` при отправке. */
  phase: 'domains' | 'pack' | 'upload'
  current: number
  total: number
}
