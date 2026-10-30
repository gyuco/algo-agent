import { useI18n } from '../i18n/useI18n'
import type { ConnectionsState } from './useConnections'

/** Header indicator: which providers are connected, linking to the Connections page. */
export function ConnectionsBadge({ state }: { state: ConnectionsState }) {
  const { t } = useI18n()
  const { connected, checking } = state

  const checkingNow = checking && connected.length === 0
  const label = checkingNow
    ? t('connections.checking')
    : connected.length === 0
      ? t('connections.none')
      : connected.map((c) => c.label).join(' · ')
  const tone = checkingNow ? 'busy' : connected.length === 0 ? 'off' : 'ok'

  return (
    <a
      className="connections-status"
      href="#/connections"
      title={label}
      aria-label={label}
    >
      <span className={`dot ${tone}`} aria-hidden="true" />
      <span className="connections-label">{label}</span>
    </a>
  )
}
