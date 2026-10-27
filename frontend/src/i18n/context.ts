import { createContext } from 'react'
import type { Language, MessageKey } from './messages'

export interface I18nValue {
  language: Language
  setLanguage: (language: Language) => void
  t: (key: MessageKey, params?: Record<string, string>) => string
}

export const I18nContext = createContext<I18nValue | null>(null)
