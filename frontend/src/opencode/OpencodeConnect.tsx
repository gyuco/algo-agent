import type { ProviderUiProps } from '../connections/providers'
import { useI18n } from '../i18n/useI18n'
import { opencodeApi } from './api'

/** Connects the OpenCode installed on this machine. */
export function OpencodeConnect({ busy, run }: ProviderUiProps) {
  const { t } = useI18n()
  return (
    <>
      <p>
        {t('opencode.introLead')} <code>opencode auth</code>
        {t('opencode.introTail')}
      </p>
      <div className="row">
        <button type="button" disabled={busy} onClick={() => run(opencodeApi.connectLocal)}>
          {busy ? t('connect.verifying') : t('opencode.connect')}
        </button>
      </div>
    </>
  )
}
