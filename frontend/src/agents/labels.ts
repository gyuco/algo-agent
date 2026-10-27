import type { MessageKey } from '../i18n/messages'
import type { FileAccess } from './api'

export const FILE_ACCESS_KEY: Record<FileAccess, MessageKey> = {
  none: 'access.none',
  read: 'access.read',
  write: 'access.write',
}
