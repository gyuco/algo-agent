import { useRef, useState, type FormEvent } from 'react'
import { useI18n } from '../i18n/useI18n'
import {
  ACCEPT,
  MAX_ATTACHMENTS,
  readAttachment,
  type Attachment,
} from '../chat/attachments'
import {
  missionsApi,
  type MissionMode,
  type OrchestratorModel,
} from './api'

interface Props {
  projectId: number
  /** Chat conversation the mission starts from: the request may be left empty. */
  fromSession?: string
  onDone: (missionId: number) => void
  onCancel?: () => void
}

/** The "new mission" form, also used when turning a conversation into a mission. */
export function MissionForm({ projectId, fromSession, onDone, onCancel }: Props) {
  const { t } = useI18n()
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<MissionMode>('step')
  const [orchestratorModel, setOrchestratorModel] = useState<OrchestratorModel>('claude:opus')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function attach(files: Iterable<File>) {
    setError(null)
    const list = [...attachments]
    for (const file of files) {
      if (list.length >= MAX_ATTACHMENTS) break
      try {
        list.push(await readAttachment(file, file.name))
      } catch (err) {
        setError(err instanceof Error ? err.message : t('error.unexpected'))
      }
    }
    setAttachments(list)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    if (!input.trim() && !attachments.length && !fromSession) return
    setBusy(true)
    setError(null)
    try {
      const mission = await missionsApi.create(projectId, {
        input,
        mode,
        orchestratorModel,
        attachments: attachments.length ? attachments : undefined,
        fromSession,
      })
      onDone(mission.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.unexpected'))
      setBusy(false)
    }
  }

  return (
    <form className="mission-form stack" onSubmit={submit}>
      {fromSession && <p className="hint">{t('missions.fromSession')}</p>}
      <label>
        {t('missions.request')}
        <textarea
          value={input}
          rows={4}
          maxLength={20000}
          placeholder={t('missions.requestPlaceholder')}
          onChange={(e) => setInput(e.target.value)}
        />
      </label>
      <div className="row">
        <label>
          {t('missions.orchestrator')}
          <select
            value={orchestratorModel}
            onChange={(e) => setOrchestratorModel(e.target.value as OrchestratorModel)}
          >
            <option value="claude:opus">Opus</option>
            <option value="claude:sonnet">Sonnet</option>
          </select>
        </label>
        <label>
          {t('missions.mode')}
          <select value={mode} onChange={(e) => setMode(e.target.value as MissionMode)}>
            <option value="step">{t('missions.modeStep')}</option>
            <option value="auto">{t('missions.modeAuto')}</option>
          </select>
        </label>
      </div>
      <div className="row">
        <button
          type="button"
          className="secondary"
          disabled={busy || attachments.length >= MAX_ATTACHMENTS}
          onClick={() => fileRef.current?.click()}
        >
          {t('chat.attach')}
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            if (e.target.files) void attach(e.target.files)
            e.target.value = ''
          }}
        />
        {attachments.map((a, i) => (
          <span className="badge" key={`${a.name}-${i}`}>
            {a.name}
            <button
              type="button"
              className="link"
              aria-label={t('chat.removeAttachment', { name: a.name })}
              onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit" disabled={busy || (!input.trim() && !attachments.length && !fromSession)}>
          {t(busy ? 'missions.starting' : 'missions.start')}
        </button>
        {onCancel && (
          <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
            {t('missions.cancel')}
          </button>
        )}
      </div>
    </form>
  )
}
