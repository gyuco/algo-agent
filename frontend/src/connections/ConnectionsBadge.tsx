import { useI18n } from '../i18n/useI18n'
import type { ConnectionsState } from './useConnections'

/** Header indicator: which providers are connected, linking to the Connections page. */
export function ConnectionsBadge({ state }: { state: ConnectionsState }) {
  const { t } = useI18n()
  const { connected, checking } = state

  return (
    <a className="connections-status" href="#/connections">
      {checking && connected.length === 0 ? (
        <span>{t('connections.checking')}</span>
      ) : connected.length === 0 ? (
        <span>
          <span className="dot off" aria-hidden="true" /> {t('connections.none')}
        </span>
      ) : (
        <span>
          <span className="dot ok" aria-hidden="true" /> {connected.map((c) => c.label).join(' · ')}
        </span>
      )}
    </a>
  )
}
