import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n/useI18n'
import { claudeApi } from './api'
import { UsagePanel } from './UsagePanel'
import type { ClaudeStatusState } from './useClaudeStatus'

const METHOD_LABEL = {
  api_key: 'API key',
  oauth_token: 'abbonamento Claude',
} as const

interface Props {
  claude: ClaudeStatusState
  onClose: () => void
}

/** Plan usage, connection details and disconnect, opened from the header. */
export function UsageModal({ claude, onClose }: Props) {
  const { t } = useI18n()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { status, busy, error, run, reload } = claude

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  const disconnect = () =>
    run(async () => {
      await claudeApi.disconnect()
      await reload()
    })

  return (
    <dialog ref={dialogRef} className="usage-modal" onClose={onClose} aria-label={t('usage.title')}>
      <button
        type="button"
        className="icon close"
        aria-label={t('usage.close')}
        onClick={() => dialogRef.current?.close()}
      >
        ×
      </button>
      {status?.connected && <UsagePanel status={status} busy={busy} run={run} />}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {status?.connected && status.method && (
        <div className="usage-foot connection">
          <span>
            Tramite {METHOD_LABEL[status.method]} <code>{status.secretHint}</code>
          </span>
          <button type="button" className="secondary" disabled={busy} onClick={disconnect}>
            Disconnetti
          </button>
        </div>
      )}
    </dialog>
  )
}
