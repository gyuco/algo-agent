import { useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import { UsageModal } from './UsageModal'
import type { ClaudeStatusState } from './useClaudeStatus'

/** Header indicator: Claude Code connection state and a button opening the usage modal. */
export function ClaudeStatusBadge({ claude }: { claude: ClaudeStatusState }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const { status, checking } = claude
  const connected = Boolean(status?.connected)

  return (
    <div className="claude-status">
      {checking ? (
        <span>{t('claude.checking')}</span>
      ) : (
        <span>
          <span className={`dot ${connected ? 'ok' : 'off'}`} aria-hidden="true" />{' '}
          {t(connected ? 'claude.connected' : 'claude.disconnected')}
        </span>
      )}
      {connected && (
        <button
          type="button"
          className="icon"
          aria-label={t('usage.open')}
          title={t('usage.open')}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              d="M4 20V10M10 20V4M16 20v-7M22 20H2"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
      {open && <UsageModal claude={claude} onClose={() => setOpen(false)} />}
    </div>
  )
}
