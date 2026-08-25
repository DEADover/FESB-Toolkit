import type { Connection } from '../types'

/**
 * Хранение параметров подключения между запусками.
 *
 * Адрес и имя пользователя запоминаются всегда, пароль — только по явной
 * галочке: браузерное хранилище не шифруется, и держать там пароль от шины
 * без спроса нельзя.
 */

const STORAGE_KEY = 'fesb.connection'

export interface StoredConnection {
  url: string
  username: string
  password: string
  insecure: boolean
  rememberPassword: boolean
}

export const EMPTY_CONNECTION: StoredConnection = {
  url: '',
  username: '',
  password: '',
  insecure: false,
  rememberPassword: false,
}

export function readConnection(): StoredConnection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY_CONNECTION
    const parsed = JSON.parse(raw) as Partial<StoredConnection>
    return {
      url: typeof parsed.url === 'string' ? parsed.url : '',
      username: typeof parsed.username === 'string' ? parsed.username : '',
      password: parsed.rememberPassword && typeof parsed.password === 'string' ? parsed.password : '',
      insecure: parsed.insecure === true,
      rememberPassword: parsed.rememberPassword === true,
    }
  } catch {
    return EMPTY_CONNECTION
  }
}

export function storeConnection(value: StoredConnection): void {
  const payload: StoredConnection = {
    ...value,
    password: value.rememberPassword ? value.password : '',
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
}

export function forgetConnection(): void {
  localStorage.removeItem(STORAGE_KEY)
}

/** То, что уходит в бэкенд: без служебной галочки «запомнить». */
export function toConnection(value: StoredConnection): Connection {
  return {
    url: value.url.trim(),
    username: value.username,
    password: value.password,
    insecure: value.insecure,
  }
}
