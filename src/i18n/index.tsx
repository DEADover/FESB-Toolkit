import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import { en, type MessageKey } from './en'
import { ru } from './ru'

export type Language = 'en' | 'ru'

export const LANGUAGES: Array<{ id: Language; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'ru', label: 'Русский' },
]

const DICTIONARIES: Record<Language, Record<MessageKey, string>> = { en, ru }
const STORAGE_KEY = 'fesb.language'

/** По умолчанию английский; язык системы не подхватываем сознательно. */
function readLanguage(): Language {
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === 'ru' || stored === 'en' ? stored : 'en'
}

export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string

interface I18nValue {
  language: Language
  setLanguage: (language: Language) => void
  t: Translate
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(readLanguage)

  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  const setLanguage = useCallback((next: Language) => {
    localStorage.setItem(STORAGE_KEY, next)
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

export function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useI18n используется вне I18nProvider')
  return value
}

export type { MessageKey }
