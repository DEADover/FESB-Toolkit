// Список стендов в файле: передать коллеге или перенести на другую машину.
//
// В файл идёт всё, что нужно, чтобы подключиться, кроме секретов: пароли
// шины и брокера и пароль ключа клиента не выгружаются никогда. Файл
// пересылают почтой и в мессенджерах, и пароль от продуктива в нём был бы
// утечкой. При загрузке пароль вводят заново.

import { blankBroker, busUrl, sanitize, type BrokerSettings, type ConnectionProfile, type ConnectionStore } from './connection'

export const STANDS_FORMAT = 'fesb-toolkit/stands'
const STANDS_VERSION = 1

type SharedBroker = Omit<BrokerSettings, 'password' | 'clientKeyPassphrase'>
type SharedStand = Pick<ConnectionProfile, 'name' | 'environment' | 'url' | 'port' | 'username' | 'insecure'> & {
  broker: SharedBroker
}

interface StandsFile {
  format: typeof STANDS_FORMAT
  version: number
  exportedAt: string
  stands: SharedStand[]
}

/** Файл со стендами — без паролей, идентификаторов и времени последнего подключения. */
export function exportStands(profiles: ConnectionProfile[], exportedAt: string): string {
  const stands: SharedStand[] = profiles.map((profile) => {
    const { password: _password, clientKeyPassphrase: _passphrase, ...broker } = profile.broker
    return {
      name: profile.name,
      environment: profile.environment,
      url: profile.url,
      port: profile.port,
      username: profile.username,
      insecure: profile.insecure,
      broker,
    }
  })
  const file: StandsFile = { format: STANDS_FORMAT, version: STANDS_VERSION, exportedAt, stands }
  return `${JSON.stringify(file, null, 2)}\n`
}

export type StandsFileError = 'notJson' | 'notStands' | 'newerVersion' | 'empty'

export class StandsFileProblem extends Error {
  constructor(readonly reason: StandsFileError) {
    super(reason)
  }
}

/**
 * Профили из файла. Пароли, даже если их вписали в файл руками, не берутся:
 * хранить их или нет, человек решает галочкой в карточке стенда.
 */
export function parseStands(text: string): ConnectionProfile[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new StandsFileProblem('notJson')
  }
  const file = parsed as Partial<StandsFile> | null
  if (!file || typeof file !== 'object' || file.format !== STANDS_FORMAT || !Array.isArray(file.stands)) {
    throw new StandsFileProblem('notStands')
  }
  if (typeof file.version === 'number' && file.version > STANDS_VERSION) throw new StandsFileProblem('newerVersion')
  const profiles = file.stands
    .map((stand) => sanitize({
      ...(stand as Partial<ConnectionProfile>),
      id: undefined,
      password: '',
      rememberPassword: false,
      lastUsedAt: null,
      broker: { ...blankBroker(), ...((stand as Partial<SharedStand>)?.broker ?? {}), password: '', clientKeyPassphrase: '' },
    }))
    .filter((profile): profile is ConnectionProfile => profile !== null)
  if (profiles.length === 0) throw new StandsFileProblem('empty')
  return profiles
}

/** Один и тот же стенд — тот же адрес шины под тем же пользователем. */
function standKey(profile: ConnectionProfile): string {
  return `${busUrl(profile).toLowerCase()}|${profile.username.trim().toLowerCase()}`
}

export interface ImportItem {
  profile: ConnectionProfile
  /** `exists` — такой стенд уже есть: его не трогаем, чтобы не затереть пароль и правки. */
  status: 'new' | 'exists'
  /** Имя стенда, который уже есть, — если оно отличается от имени в файле. */
  existingName: string | null
}

export function planImport(store: ConnectionStore, incoming: ConnectionProfile[]): ImportItem[] {
  const known = new Map(store.profiles.map((profile) => [standKey(profile), profile]))
  const seen = new Set<string>()
  const items: ImportItem[] = []
  for (const profile of incoming) {
    const key = standKey(profile)
    // Повтор внутри самого файла — один стенд, а не два.
    if (seen.has(key)) continue
    seen.add(key)
    const existing = known.get(key)
    items.push({
      profile,
      status: existing ? 'exists' : 'new',
      existingName: existing && existing.name !== profile.name ? existing.name : null,
    })
  }
  return items
}

/** Добавляет новые стенды в конец списка; уже известные остаются как были. */
export function applyImport(store: ConnectionStore, items: ImportItem[]): ConnectionStore {
  const added = items.filter((item) => item.status === 'new').map((item) => item.profile)
  return { ...store, profiles: [...store.profiles, ...added] }
}

/** Имя файла по умолчанию: `fesb-stands-2026-09-28.json`. */
export function standsFileName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `fesb-stands-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`
}
