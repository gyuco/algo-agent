import type { FileAccess } from './api'

export const FILE_ACCESS_LABEL: Record<FileAccess, string> = {
  none: 'nessun accesso',
  read: 'sola lettura',
  write: 'lettura e scrittura',
}
