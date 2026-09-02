import type { Connection } from '../types'

/**
 * Профили подключений: как они хранятся между запусками и что с ними можно делать.
 *
 * Адрес, имя пользователя и среда запоминаются всегда, пароль — только по явной
 * галочке: браузерное хранилище не шифруется, и держать там пароль от боевой
 * шины без спроса нельзя.
 */

const STORAGE_KEY = 'fesb.connections'
/** Ключ одиночного подключения из версий до профилей. */
const LEGACY_KEY = 'fesb.connection'

/** Среда стенда. Порядок — жизненный цикл: разработка → бой. */
export const ENVIRONMENTS = ['dev', 'test', 'stage', 'prod'] as const
export type Environment = (typeof ENVIRONMENTS)[number]

/**
 * Брокер стенда — часть его профиля, а не отдельная сущность.
 *
 * У шины и её брокера один хозяин и один стенд: разработка, тест, бой.
 * Держать их порознь означало бы дважды заводить одно и то же и однажды
 * переключить шину, забыв про брокер.
 *
 * Узел по умолчанию берётся у шины: брокер почти всегда живёт там же.
 * `host` заполняют, только когда это не так.
 */
export interface BrokerSettings {
  /** Пусто — тот же узел, что у шины. */
  host: string
  port: string
  /** Пусто — те же учётные данные, что у шины. */
  username: string
  password: string
  /** Очередь, которая подставляется в поле «Куда» при отправке. */
  queue: string
  useTls: boolean
  tlsSkipVerify: boolean
  saslAnonymous: boolean
  useWs: boolean
  wsPath: string
  containerId: string
  heartbeatSecs: string
  connectTimeoutSecs: string
  reconnectBaseMs: string
  reconnectMaxMs: string
  reconnectMultiplier: string
  sendRetryAttempts: string
  sendRetryDelayMs: string
  clientCertPath: string
  clientKeyPath: string
  clientKeyPassphrase: string
}

export function blankBroker(): BrokerSettings {
  return {
    host: '', port: '5672', username: '', password: '', queue: '',
    useTls: false, tlsSkipVerify: false, saslAnonymous: false,
    useWs: false, wsPath: '', containerId: '',
    heartbeatSecs: '0', connectTimeoutSecs: '10',
    reconnectBaseMs: '1000', reconnectMaxMs: '30000', reconnectMultiplier: '2',
    sendRetryAttempts: '1', sendRetryDelayMs: '250',
    clientCertPath: '', clientKeyPath: '', clientKeyPassphrase: '',
  }
}

export interface ConnectionProfile {
  id: string
  name: string
  environment: Environment
  /** Узел шины: `esb.corp`. Схему и путь до менеджера бэкенд подбирает сам. */
  url: string
  /** Порт шины отдельным полем. Пусто — порт по умолчанию для схемы. */
  port: string
  username: string
  password: string
  rememberPassword: boolean
  /** Принимать самоподписанные сертификаты. */
  insecure: boolean
  /** Брокер AMQP этого же стенда. */
  broker: BrokerSettings
  lastUsedAt: string | null
}

export interface ConnectionStore {
  profiles: ConnectionProfile[]
  lastUsedId: string | null
  /** Подключаться к последнему стенду при запуске приложения. */
  autoConnect: boolean
}

export const EMPTY_STORE: ConnectionStore = { profiles: [], lastUsedId: null, autoConnect: false }

export function blankProfile(): ConnectionProfile {
  return {
    id: newId(),
    name: '',
    environment: 'test',
    url: '',
    port: DEFAULT_PORT,
    username: '',
    password: '',
    rememberPassword: false,
    insecure: false,
    broker: blankBroker(),
    lastUsedAt: null,
  }
}

/** Порт менеджера FESB из коробки. */
const DEFAULT_PORT = '8181'

/**
 * Адрес шины целиком: узел из одного поля, порт из другого.
 *
 * Порт долго жил внутри адреса, и профили из тех времён приходят с ним
 * внутри. Такой адрес возвращается как есть: порт в нём указан явно,
 * и подставлять второй поверх нельзя.
 */
export function busUrl(profile: ConnectionProfile): string {
  const raw = profile.url.trim().replace(/\/+$/, '')
  const port = profile.port.trim()
  if (!raw || !port) return raw

  const scheme = raw.match(/^[a-z][a-z0-9+.-]*:\/\//i)?.[0] ?? ''
  const rest = raw.slice(scheme.length)
  const slash = rest.indexOf('/')
  const host = slash === -1 ? rest : rest.slice(0, slash)
  const path = slash === -1 ? '' : rest.slice(slash)
  if (/:\d+$/.test(host)) return raw

  return `${scheme}${host}:${port}${path}`
}

/** Порт, вынутый из адреса старого профиля: `esb.corp:8181` → `8181`. */
function portInside(url: string): { url: string; port: string } | null {
  const scheme = url.match(/^[a-z][a-z0-9+.-]*:\/\//i)?.[0] ?? ''
  const rest = url.slice(scheme.length)
  const slash = rest.indexOf('/')
  const host = slash === -1 ? rest : rest.slice(0, slash)
  const path = slash === -1 ? '' : rest.slice(slash)
  const found = host.match(/^(.*):(\d+)$/)
  if (!found) return null
  return { url: `${scheme}${found[1]}${path}`, port: found[2] }
}

function newId(): string {
  // randomUUID есть во всех webview, до которых дотягивается Tauri 2,
  // но запасной вариант дешевле, чем упасть на сохранении профиля.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `profile-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

function sanitize(raw: Partial<ConnectionProfile>): ConnectionProfile | null {
  if (typeof raw.url !== 'string' || raw.url.trim() === '') return null
  const remember = raw.rememberPassword === true
  const environment = ENVIRONMENTS.includes(raw.environment as Environment)
    ? (raw.environment as Environment)
    : 'test'
  // Порт стал отдельным полем; у профилей, записанных до этого, он сидит
  // внутри адреса — вынимаем его туда, где его теперь правят.
  const split = typeof raw.port === 'string' ? null : portInside(raw.url.trim())

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : raw.url,
    environment,
    url: split ? split.url : raw.url,
    port: typeof raw.port === 'string' ? raw.port : (split?.port ?? ''),
    username: typeof raw.username === 'string' ? raw.username : '',
    password: remember && typeof raw.password === 'string' ? raw.password : '',
    rememberPassword: remember,
    insecure: raw.insecure === true,
    // Профили из версий до слияния брокера в стенд читаются как есть:
    // недостающие поля берутся из пустой заготовки. Пароль брокера живёт
    // по тем же правилам, что и пароль шины: галочка одна на стенд.
    broker: forget(remember, { ...blankBroker(), ...(raw.broker ?? {}) }),
    lastUsedAt: typeof raw.lastUsedAt === 'string' ? raw.lastUsedAt : null,
  }
}

/** Секреты брокера — только при явно разрешённом хранении пароля. */
function forget(remember: boolean, broker: BrokerSettings): BrokerSettings {
  if (remember) return broker
  return { ...broker, password: '', clientKeyPassphrase: '' }
}

/** Единственное подключение старых версий становится первым профилем. */
function migrateLegacy(): ConnectionProfile[] {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Partial<ConnectionProfile>
    const profile = sanitize({ ...parsed, name: 'FESB', environment: 'test' })
    return profile ? [profile] : []
  } catch {
    return []
  }
}

export function readStore(): ConnectionStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      const migrated = migrateLegacy()
      if (migrated.length === 0) return EMPTY_STORE
      const store: ConnectionStore = { profiles: migrated, lastUsedId: migrated[0].id, autoConnect: false }
      writeStore(store)
      localStorage.removeItem(LEGACY_KEY)
      return store
    }
    const parsed = JSON.parse(raw) as Partial<ConnectionStore>
    const profiles = Array.isArray(parsed.profiles)
      ? parsed.profiles.map(sanitize).filter((item): item is ConnectionProfile => item !== null)
      : []
    return {
      profiles,
      lastUsedId: profiles.some((item) => item.id === parsed.lastUsedId) ? parsed.lastUsedId! : null,
      autoConnect: parsed.autoConnect === true,
    }
  } catch {
    return EMPTY_STORE
  }
}

export function writeStore(store: ConnectionStore): void {
  const payload: ConnectionStore = {
    ...store,
    // Пароль без галочки на диск не попадает даже случайно.
    profiles: store.profiles.map((profile) => ({
      ...profile,
      password: profile.rememberPassword ? profile.password : '',
      broker: forget(profile.rememberPassword, profile.broker),
    })),
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
}

export function upsertProfile(store: ConnectionStore, profile: ConnectionProfile): ConnectionStore {
  const exists = store.profiles.some((item) => item.id === profile.id)
  return {
    ...store,
    profiles: exists
      ? store.profiles.map((item) => (item.id === profile.id ? profile : item))
      : [...store.profiles, profile],
  }
}

export function removeProfile(store: ConnectionStore, id: string): ConnectionStore {
  return {
    ...store,
    profiles: store.profiles.filter((item) => item.id !== id),
    lastUsedId: store.lastUsedId === id ? null : store.lastUsedId,
  }
}

/** Отмечает профиль использованным — по нему потом идёт автоподключение. */
export function markUsed(store: ConnectionStore, id: string, at: string): ConnectionStore {
  return {
    ...store,
    lastUsedId: id,
    profiles: store.profiles.map((item) => (item.id === id ? { ...item, lastUsedAt: at } : item)),
  }
}

/** Профили по средам в порядке жизненного цикла; пустые среды пропускаются. */
export function byEnvironment(profiles: ConnectionProfile[]): Array<[Environment, ConnectionProfile[]]> {
  return ENVIRONMENTS.map((environment) => [
    environment,
    profiles
      .filter((profile) => profile.environment === environment)
      .sort((a, b) => a.name.localeCompare(b.name)),
  ] as [Environment, ConnectionProfile[]]).filter(([, list]) => list.length > 0)
}

/**
 * Профиль, к которому можно подключиться без вопросов при запуске.
 *
 * Без сохранённого пароля автоподключение невозможно — врать об этом нельзя,
 * интерфейс в таком случае просто подставит профиль и подождёт ввода.
 */
export function autoConnectTarget(store: ConnectionStore): ConnectionProfile | null {
  if (!store.autoConnect || !store.lastUsedId) return null
  const profile = store.profiles.find((item) => item.id === store.lastUsedId)
  if (!profile || !profile.rememberPassword || !profile.password) return null
  return profile
}

/** То, что уходит в бэкенд: без имени, среды и служебных отметок. */
export function toConnection(profile: ConnectionProfile): Connection {
  return {
    url: busUrl(profile),
    username: profile.username,
    password: profile.password,
    insecure: profile.insecure,
  }
}

/** Профиль заполнен настолько, что имеет смысл пробовать подключиться. */
export function isReady(profile: ConnectionProfile): boolean {
  return profile.url.trim().length > 0 && profile.username.trim().length > 0
}
