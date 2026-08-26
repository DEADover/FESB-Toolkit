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

export interface ConnectionProfile {
  id: string
  name: string
  environment: Environment
  url: string
  username: string
  password: string
  rememberPassword: boolean
  /** Принимать самоподписанные сертификаты. */
  insecure: boolean
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
    username: '',
    password: '',
    rememberPassword: false,
    insecure: false,
    lastUsedAt: null,
  }
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
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : raw.url,
    environment,
    url: raw.url,
    username: typeof raw.username === 'string' ? raw.username : '',
    password: remember && typeof raw.password === 'string' ? raw.password : '',
    rememberPassword: remember,
    insecure: raw.insecure === true,
    lastUsedAt: typeof raw.lastUsedAt === 'string' ? raw.lastUsedAt : null,
  }
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
    url: profile.url.trim(),
    username: profile.username,
    password: profile.password,
    insecure: profile.insecure,
  }
}

/** Профиль заполнен настолько, что имеет смысл пробовать подключиться. */
export function isReady(profile: ConnectionProfile): boolean {
  return profile.url.trim().length > 0 && profile.username.trim().length > 0
}
