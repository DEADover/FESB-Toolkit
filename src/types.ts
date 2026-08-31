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
  /** Не для показа: по нему интерфейс решает, отступать ли под кнопки macOS. */
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

export interface VerifyMismatch {
  domain: string
  bean: string | null
  /** `broker`, `queue`, `traceMode` или `bean` — объекта нет на сервере. */
  field: string
  expected: string | null
  actual: string | null
}

export interface VerifyResult {
  domains: number
  beans: number
  /** Сколько значений совпало с локальными файлами. */
  values: number
  mismatches: VerifyMismatch[]
  checkedAt: string
}

export interface ApiProgress {
  /** `domains` при выгрузке, `pack` и `upload` при отправке, `verify` при сверке. */
  phase: 'domains' | 'pack' | 'upload' | 'verify'
  current: number
  total: number
}

// ─────────────────────── модули, очереди, константы, журналы ───────────────────────

export interface ModuleRow {
  name: string
  label: string
  /** Модуль включён в конфигурации — то есть должен работать. */
  active: boolean
  running: boolean
  warning: boolean
  /** Конфигурация изменилась, но модуль ещё работает со старой. */
  awaitRestart: boolean
  awaitSystemRestart: boolean
  dependencies: string[]
}

export type ModuleAction = 'start' | 'stop' | 'restart'

/** Домены управляются теми же тремя действиями, что и модули. */
export type DomainAction = ModuleAction

export interface DomainActionResult {
  guid: string
  action: string
  /** Шина ответила согласием. Отказ приходит телом `false` при HTTP 200. */
  done: boolean
}

export type ManagerKind = 'QMS' | 'QME' | 'RQMS'

export interface QueueManager {
  kind: ManagerKind
  id: string
  /** То, что пишется в property `broker`: например `QME:EQM_MON`. */
  broker: string
  status: string
  running: boolean
  autoStart: boolean
}

export interface QueueRow {
  name: string
  address: string | null
  messages: number
  consumers: number
  producers: number | null
  enqueued: number | null
  dequeued: number | null
  /** Служебная очередь самого менеджера. */
  internal: boolean
  paused: boolean
  durable: boolean
}

export interface PropertyRow {
  key: string
  value: string | null
  secured: boolean
  vault: boolean
  empty: boolean
  description: string | null
}

/** Где живут константы. Для домена нужен его guid, а не имя. */
export type PropertyScope = 'application' | 'broker' | { domain: string }

export interface LogFileRow {
  name: string
  size: number
  lastModified: string | null
}

export interface LogEntry {
  timestamp: string | null
  level: string | null
  file: string | null
  thread: string | null
  className: string | null
  message: string | null
}

export interface LogRequest {
  logs: string[]
  levels: string[]
  search: string | null
  limit: number
}

// ─────────────────────────── схема СОПС ───────────────────────────

export interface RouteExpression {
  language: string
  text: string
}

export interface RouteAttribute {
  name: string
  value: string
}

export interface RouteNode {
  /** Имя элемента Camel: `to`, `choice`, `doTry`, `setHeader`… */
  kind: string
  /** Подпись из редактора схем FESB. */
  label: string | null
  /** Блок редактора, которым поставлен шаг. */
  component: string | null
  uri: string | null
  expression: RouteExpression | null
  description: string | null
  format: string | null
  exceptions: string[]
  attributes: RouteAttribute[]
  /**
   * Присвоения одного компонента: «имя → выражение».
   *
   * Пусто у обычных шагов. Заполнено там, где в редакторе FESB стоит таблица:
   * один блок «Установить переменные» кладёт в XML столько элементов, сколько
   * в нём строк, и рисовать их отдельными шагами нельзя.
   */
  assignments?: RouteAssignment[]
  children: RouteNode[]
  line: number
}

export interface RouteAssignment {
  name: string
  language: string | null
  value: string
}

export interface RouteGraph {
  id: string | null
  name: string | null
  description: string | null
  traceEnabled: boolean
  traceConfig: string | null
  /** Сколько шагов в схеме, включая вложенные ветки. */
  steps: number
  nodes: RouteNode[]
  line: number
}

// ─────────────── карта доменов, живые СОПС, точки восстановления ───────────────

export interface DomainStat {
  guid: string
  name: string
  active: boolean
  routes: number
  running: number
  success: number
  errors: number
  inflight: number
}

export interface RouteFile {
  id: string | null
  name: string | null
  traceEnabled: boolean
  traceConfigs: string[]
  inlineTraceConfig: boolean
  /** Путь к файлу маршрута во временной копии — по нему рисуется схема. */
  path: string
}

export interface DomainRoutes {
  guid: string
  name: string | null
  /** Корень временной копии — по нему считаются связи между маршрутами. */
  root: string
  routes: RouteFile[]
}

export interface RouteState {
  id: string
  name: string | null
  /** `Started`, `Stopped`, `Suspended` — как их называет сама шина. */
  state: string | null
  autoStartup: boolean
  trace: boolean
  traceConfig: string | null
  processed: number
  failed: number
  failuresHandled: number
  inflight: number
  rate: number
  minMs: number
  meanMs: number
  maxMs: number
  firstProcessed: string | null
  lastProcessed: string | null
}

export type RouteAction = 'start' | 'stop' | 'forceStop' | 'reset'

export interface SavePoint {
  version: string | null
  filename: string
  date: string | null
}

export interface MessageProperty {
  name: string
  value: string
}

export interface QueueMessage {
  id: string
  correlationId: string | null
  timestamp: string | null
  priority: number | null
  size: number
  bodySize: number
  bodyType: string | null
  persistent: boolean
  redelivered: boolean
  replyTo: string | null
  properties: MessageProperty[]
  /** Тело приходит только у отдельно запрошенного сообщения. */
  body: string | null
  truncated: boolean
}

/** Сообщение, в теле которого нашёлся искомый текст. */
export interface QueueMatch {
  id: string
  /** Кусок тела вокруг найденного — видно, за что зацепилось. */
  excerpt: string
}

// ─────────────────────────── связи СОПС ───────────────────────────

export interface LinkedRoute {
  id: string | null
  name: string | null
  domain: string
  domainDir: string
  path: string
}

export interface RouteLink {
  from: number
  to: number
  uri: string
  /** `call` — прямой вызов, `queue` — через транспорт. */
  kind: string
}

export interface LinkGraph {
  routes: LinkedRoute[]
  links: RouteLink[]
}

/** Связь глазами открытой схемы: куда ведёт и каким адресом. */
export interface RouteNeighbour {
  name: string | null
  domain: string
  path: string
  uri: string
  kind: string
}

export interface RouteNeighbours {
  incoming: RouteNeighbour[]
  outgoing: RouteNeighbour[]
}

export interface AuditEntry {
  timestamp: string | null
  /** `action` — действие, `login` — вход, `session` — сессия, `other` — прочее. */
  kind: string
  user: string | null
  ip: string | null
  action: string | null
  arguments: string | null
  status: number | null
  text: string
}

/** СОПС в обзоре по всему серверу: одна строка на маршрут. */
export interface RouteSummary {
  id: string
  name: string
  domain: string
  domainGuid: string
  /** `Started`, `Stopped` — как их называет сама шина. */
  state: string
  trace: boolean
  /** Объекты трассировки этого СОПС: шина склеивает их через запятую. */
  traceBeans: string[]
  processed: number
  failed: number
  failuresHandled: number
  inflight: number
  minMs: number | null
  meanMs: number | null
  maxMs: number | null
  lastProcessed: string | null
  tags: string[]
}

export interface DomainRouteNames {
  guid: string
  name: string
  routes: string[]
}

/**
 * Внешняя точка входа или выхода одного СОПС.
 *
 * `null` в поле значит «сведений нет», а не «нет»: шина рассказывает о TLS
 * и авторизации только там, где точка описана фабрикой Jetty.
 */
export interface ApiEndpoint {
  domain: string
  domainGuid: string
  route: string
  routeId: string
  component: string
  /** `in` — точка входа, `out` — точка выхода. */
  direction: 'in' | 'out'
  /** Что это за точка: HTTP, SOAP, FTP, SQL… — по схеме адреса. */
  kind: string
  scheme: string
  uri: string
  host: string | null
  port: number | null
  /**
   * Менеджер очередей локальной очереди: `QME:EQM`, `QMS:QM`.
   *
   * Только у `localmq`. `null` — менеджер не назван ни в адресе, ни в
   * настройках домена, а значит работает общий для сервера.
   */
  manager: string | null
  ssl: boolean | null
  protocol: string | null
  ciphers: string | null
  auth: string | null
  state: string | null
  /**
   * Слушает ли шина этот порт на самом деле.
   *
   * Только у точек входа: проверка идёт на хосте шины, а порт исходящей
   * точки принадлежит чужой системе.
   */
  listening: boolean | null
  /** Время непрерывной работы: шина его не отдаёт, поэтому всегда пусто. */
  uptime: string | null
  busyThreads: number | null
  utilizedThreads: number | null
  readyThreads: number | null
  minThreads: number | null
  maxThreads: number | null
  queueSize: number | null
  idleTimeout: number | null
  idleThreads: number | null
}

/** Строка истории отчётов: всё, что показывается, не читая сам отчёт. */
export interface ReportEntry {
  id: string
  /** Адрес сервера — по нему отчёты и разделяются. */
  server: string
  /** Когда собран, в местном времени: `2026-08-27T21:15:04`. */
  builtAt: string
  points: number
  hosts: number
}

export interface StoredReport extends ReportEntry {
  endpoints: ApiEndpoint[]
}

/** Право в том виде, в каком его описывает шина; описания приходят по-русски. */
export interface Permission {
  name: string
  group: string
  description: string
}

/** Область, на которую роль распространяет права. */
export interface Scope {
  /** Над чем: `domains`, `qms`, `logFilePrefixes`. */
  subject: string
  /** Что можно: `view`, `edit`, `action`, `export`. */
  action: string
  values: string[]
}

export interface Role {
  name: string
  permissions: string[]
  scopes: Scope[]
}

export interface Session {
  ip: string
  agent: string | null
  /** Сколько одинаковых сеансов с этого адреса. */
  count: number
}

export interface UserAccess {
  user: string
  sessions: Session[]
  /** Время последнего входа, миллисекунды эпохи. */
  lastLogin: number | null
}

/** Как устроен вход на сервер. */
export interface SignIn {
  /** Учётные записи берутся из каталога. */
  ldap: boolean
  oauth: boolean
  maxAttempts: number | null
  /** Требования к паролю — регулярным выражением, как их задаёт шина. */
  passwordPolicy: string | null
  passwordEncoder: string | null
  /** Алгоритм хеширования устарел и вскрывается перебором. */
  weakEncoder: boolean
  /** Пароль подходит любой: требований нет. */
  anyPassword: boolean
  blockInactive: boolean | null
}

export interface AccessReport {
  roles: Role[]
  permissions: Permission[]
  users: UserAccess[]
  signIn: SignIn
}

/** Состояние сервера: время работы, память, процессор и диски. */
export interface ServerUsage {
  /** Сколько шина работает, в миллисекундах. */
  uptime: number | null
  version: string | null
  jvm: string | null
  os: string | null
  path: string | null
  addresses: string[]
  memoryUsed: number | null
  memoryMax: number | null
  processors: number | null
  /** Доля занятого процессора, 0..1. */
  processorUsage: number | null
  disks: DiskUsage[]
}

export interface DiskUsage {
  name: string
  /** Путь у каталога; у диска пусто. */
  path: string | null
  total: number
  used: number
  free: number
}

/** Обмен, который шина ещё не довела до конца. */
export interface InflightExchange {
  id: string
  /** Откуда обмен: домен брокера, REST или веб-сервис. */
  kind: 'broker' | 'rest' | 'ws'
  domain: string
  domainGuid: string
  route: string
  routeId: string
  /** СОПС, в котором сообщение сейчас: при вызове одного СОПС из другого это не то же самое. */
  at: string | null
  /** Шаг, на котором оно стоит. */
  node: string | null
  thread: string | null
  /** Подробность своего вида: `GET /users/42` у REST, имя операции у веб-сервиса. */
  detail: string | null
  duration: number | null
  elapsed: number | null
  interrupted: boolean
}

/** Сертификат из хранилища шины — строка раздела «Сертификаты». */
export interface ApiCertificate {
  store: string
  /** `key` — хранилище ключей, `trusted` — доверенное. */
  storeKind: 'key' | 'trusted'
  alias: string
  subject: string
  subjectName: string
  issuer: string
  issuerName: string
  selfSigned: boolean
  /** Может подписывать чужие сертификаты. */
  authority: boolean
  notBefore: string
  notAfter: string
  algorithm: string
  keyAlgorithm: string
  /** Длина ключа в битах — известна только для RSA. */
  keyBits: number | null
  serial: string
  usage: string[]
  chain: number
  chainPath: string[]
}

/** Хранилище — показывается и пустым: это тоже ответ. */
export interface CertificateStore {
  name: string
  kind: 'key' | 'trusted'
  count: number
}

export interface CertificateReport {
  stores: CertificateStore[]
  certificates: ApiCertificate[]
}
