import { LOCALES, type Language, type MessageKey } from '../i18n/messages'
import type { WaitReason } from './api'

const REASON_KEY: Record<Exclude<WaitReason['code'], 'rateLimit'>, MessageKey> = {
  instance: 'reason.instance',
  user: 'reason.user',
  project: 'reason.project',
}

type Translate = (key: MessageKey, values?: Record<string, string>) => string

/** Why a queued run is waiting, in words. */
export function reasonText(reason: WaitReason | null, t: Translate, language: Language) {
  if (!reason) return t('run.queued')
  if (reason.code === 'rateLimit') {
    const time = new Intl.DateTimeFormat(LOCALES[language], { timeStyle: 'short' }).format(new Date(reason.until))
    return t('run.waiting', { reason: t('reason.rateLimit', { time }) })
  }
  return t('run.waiting', { reason: t(REASON_KEY[reason.code]) })
}
