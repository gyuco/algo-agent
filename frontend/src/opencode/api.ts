import { api } from '../api/client'
import type { ConnectionStatus } from '../connections/api'

export const opencodeApi = {
  connectLocal: () => api<ConnectionStatus>('/connections/opencode/local', { method: 'PUT' }),
}
