import { useEffect, useRef, useState, type FormEvent } from 'react'
import { MAX_ATTACHMENTS, readAttachment, type Attachment } from '../chat/attachments'
import { useI18n } from '../i18n/useI18n'
import { projectsApi } from '../projects/api'
import { vaultForges } from '../vault/api'
import { missionsApi, type MissionMode, type OrchestratorModel } from '../missions/api'

const NAME = /^[a-z0-9][a-z0-9-_.]{0,99}$/

/** §8.5: a new project created from its mission; the briefing runs on an empty folder. */
export function NewProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (missionId: number) => void
}) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [available, setAvailable] = useState<boolean | null>(null)
  const [forges, setForges] = useState<('github' | 'gitlab')[]>([])
  const [forge, setForge] = useState<'github' | 'gitlab'>('github')
  const [namespace, setNamespace] = useState('')
  const [visibility, setVisibility] = useState<'private' | 'internal' | 'public'>('private')
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<MissionMode>('step')
  const [orchestratorModel, setOrchestratorModel] = useState<OrchestratorModel>('claude:opus')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void vaultForges()
      .then(({ forges: list }) => {
        setForges(list)
        if (list.length) setForge(list[0])
      })
      .catch(() => setForges([]))
  }, [])

  useEffect(() => {
    if (!NAME.test(name)) {
      setAvailable(name === '' ? null : false)
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      void projectsApi
        .folderAvailable(name)
        .then((result) => alive && setAvailable(result.available))
        .catch(() => alive && setAvailable(null))
    }, 250)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [name])

  async function attach(files: Iterable<File>) {
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
    if (busy || !available || !forges.includes(forge)) return
    setBusy(true)
    setError(null)
    try {
      const mission = await missionsApi.createNewProject({
        name,
        forge,
        ...(namespace.trim() ? { namespace: namespace.trim() } : {}),
        visibility,
        input,
        mode,
        orchestratorModel,
        attachments: attachments.length ? attachments : undefined,
      })
      onCreated(mission.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.unexpected'))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="card modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('projects.newMission')}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="row spread">
          <h2>{t('projects.newMission')}</h2>
          <button type="button" className="icon" aria-label={t('missions.cancel')} onClick={onClose}>
            ×
          </button>
        </header>
        <form className="stack" onSubmit={submit}>
          <label>
            {t('projects.name')}
            <input
              required
              autoFocus
              value={name}
              pattern="[a-z0-9][a-z0-9\-_.]{0,99}"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {available === false && <p className="error">{t('projects.nameTaken')}</p>}
          <label>
            {t('projects.forge')}
            <select value={forge} onChange={(e) => setForge(e.target.value as 'github' | 'gitlab')}>
              {forges.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          {forges.length === 0 && <p className="error">{t('projects.noForge')}</p>}
          <label>
            {t('projects.namespace')}
            <input value={namespace} onChange={(e) => setNamespace(e.target.value)} />
          </label>
          <label>
            {t('projects.visibility')}
            <select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as typeof visibility)}
            >
              <option value="private">{t('projects.visibility.private')}</option>
              <option value="internal">{t('projects.visibility.internal')}</option>
              <option value="public">{t('projects.visibility.public')}</option>
            </select>
          </label>
          <label>
            {t('missions.request')}
            <textarea
              rows={3}
              maxLength={20000}
              value={input}
              placeholder={t('missions.requestPlaceholder')}
              onChange={(e) => setInput(e.target.value)}
            />
          </label>
          <div className="row">
            <label>
              {t('missions.mode')}
              <select value={mode} onChange={(e) => setMode(e.target.value as MissionMode)}>
                <option value="step">{t('missions.modeStep')}</option>
                <option value="auto">{t('missions.modeAuto')}</option>
              </select>
            </label>
            <label>
              {t('missions.orchestrator')}
              <select
                value={orchestratorModel}
                onChange={(e) => setOrchestratorModel(e.target.value as OrchestratorModel)}
              >
                <option value="claude:opus">opus</option>
                <option value="claude:sonnet">sonnet</option>
              </select>
            </label>
          </div>
          <div className="row">
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => void attach(e.target.files ?? [])}
            />
            <button type="button" className="secondary" onClick={() => fileRef.current?.click()}>
              {t('chat.attach')}
            </button>
            <span className="hint">{attachments.map((a) => a.name).join(', ')}</span>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="row end">
            <button type="button" className="secondary" onClick={onClose}>
              {t('projects.cancel')}
            </button>
            <button type="submit" disabled={busy || available !== true || forges.length === 0}>
              {t('projects.createMission')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
