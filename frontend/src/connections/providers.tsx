import type { ComponentType } from 'react'
import { ClaudeConnect } from '../claude/ClaudeConnect'
import { UsagePanel } from '../claude/UsagePanel'
import type { MessageKey } from '../i18n/messages'
import { OpencodeConnect } from '../opencode/OpencodeConnect'
import type { ConnectionStatus } from './api'
import type { RunAction } from './useConnections'

export interface ProviderUiProps {
  connection: ConnectionStatus
  busy: boolean
  run: RunAction
}

/** The parts of a connection card that differ by provider. */
interface ProviderUi {
  /** Shown while not connected, when the user has a way to connect. */
  Connect: ComponentType<ProviderUiProps>
  /** Shown while connected, below the common facts. */
  Details?: ComponentType<ProviderUiProps>
  methodLabels: Record<string, MessageKey>
}

/** Provider ids the backend reports, mapped to their UI. A provider missing here still shows its status. */
export const PROVIDER_UI: Record<string, ProviderUi> = {
  claude: {
    Connect: ClaudeConnect,
    Details: UsagePanel,
    methodLabels: { api_key: 'usage.methodApiKey', oauth_token: 'usage.methodSubscription' },
  },
  opencode: {
    Connect: OpencodeConnect,
    methodLabels: { local: 'opencode.methodLocal' },
  },
}
