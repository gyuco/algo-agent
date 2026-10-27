import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { I18nContext } from './context'
import { LANGUAGES, MESSAGES, type Language, type MessageKey } from './messages'

const LANGUAGE_KEY = 'language'

function isLanguage(value: string | null): value is Language {
  return LANGUAGES.includes(value as Language)
}

function initialLanguage(): Language {
  try {
    const stored = localStorage.getItem(LANGUAGE_KEY)
    if (isLanguage(stored)) return stored
  } catch {
    // Storage unavailable: fall back to the browser language.
  }
  const browser = navigator.language.slice(0, 2)
  return isLanguage(browser) ? browser : 'en'
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState(initialLanguage)

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next)
    try {
      localStorage.setItem(LANGUAGE_KEY, next)
    } catch {
      // Storage unavailable: the choice just isn't remembered.
    }
  }, [])

  const t = useCallback(
    (key: MessageKey, params: Record<string, string> = {}) =>
      MESSAGES[language][key].replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? ''),
    [language],
  )

  const value = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
