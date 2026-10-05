import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import { keep } from '../lib/kept'
import { en, type MessageKey } from './en'
import { ru } from './ru'

export type Language = 'en' | 'ru'

export const LANGUAGES: Array<{ id: Language; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'ru', label: 'Русский' },
]

const DICTIONARIES: Record<Language, Record<MessageKey, string>> = { en, ru }
const STORAGE_KEY = 'fesb.language'

/**
 * Текущий язык вне React.
 *
 * Нужен ровно одному месту — переводу ошибок с бэкенда. Ошибку разбирает
 * `errorText`, обычная функция, которую вызывают из тридцати с лишним
 * мест внутри `useCallback`. Превращать её в хук значило бы переписать все
 * эти места и их списки зависимостей ради одной строки; читать отсюда
 * дешевле и честнее — язык всё равно один на приложение.
 */
let current: Language = 'en'

export function translate(key: MessageKey, values?: Record<string, string | number>): string {
  const template = DICTIONARIES[current][key] ?? key
  if (!values) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  )
}

/** По умолчанию английский; язык системы не подхватываем сознательно. */
function readLanguage(): Language {
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === 'ru' || stored === 'en' ? stored : 'en'
}

/**
 * Число по правилам языка интерфейса: «385 200» по-русски, «385,200» по-английски.
 *
 * `toLocaleString()` без языка берёт язык системы, и в русском интерфейсе
 * на английской системе числа шли с запятыми — рядом с русскими подписями.
 */
export function formatNumber(value: number): string {
  return value.toLocaleString(current === 'ru' ? 'ru-RU' : 'en-US')
}

/** Дата и время по правилам языка интерфейса. */
export function formatDateTime(value: Date): string {
  return value.toLocaleString(current === 'ru' ? 'ru-RU' : 'en-US', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string

interface I18nValue {
  language: Language
  setLanguage: (language: Language) => void
  t: Translate
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => {
    // Язык ставится до первой отрисовки: иначе числа первого кадра
    // форматировались бы по-английски и перерисовывались.
    current = readLanguage()
    return current
  })

  useEffect(() => {
    document.documentElement.lang = language
    current = language
  }, [language])

  const setLanguage = useCallback((next: Language) => {
    keep(STORAGE_KEY, next)
    current = next
    setLanguageState(next)
  }, [])

  const t = useCallback<Translate>(
    (key, values) => {
      const template = DICTIONARIES[language][key] ?? key
      if (!values) return template
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in values ? String(values[name]) : match,
      )
    },
    [language],
  )

  const value = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/**
 * Строка перевода, в которую подставлены не значения, а узлы.
 *
 * «Причина в журналах» должна быть не советом, а ссылкой: в подсказках
 * приложение то и дело просит сходить в другой раздел, и ходить туда
 * пусть будет одним нажатием, а не поиском по меню. Место подстановки
 * помечается в словаре так же, как обычный плейсхолдер: `{logs}`.
 */
export function useRichText(): (key: MessageKey, slots: Record<string, ReactNode>) => ReactNode[] {
  const { t } = useI18n()
  return useCallback(
    (key, slots) => {
      // Обычные значения подставляет `t`, узлы — мы; в одной строке
      // встречается и то и другое: «не запустил {name}, причина в {logs}».
      const plain = Object.fromEntries(
        Object.entries(slots).filter(([, value]) => typeof value === 'string' || typeof value === 'number'),
      ) as Record<string, string | number>
      return t(key, plain)
      .split(/(\{\w+\})/)
      .map((part, index) => {
        const name = /^\{(\w+)\}$/.exec(part)?.[1]
        const slot = name ? slots[name] : undefined
        return <Fragment key={index}>{slot ?? part}</Fragment>
      })
    },
    [t],
  )
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useI18n используется вне I18nProvider')
  return value
}

export type { MessageKey }
