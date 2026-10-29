import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ACCEPT,
  MAX_ATTACHMENTS,
  readAttachment,
  type Attachment,
} from '../chat/attachments'
import { MessageText } from '../chat/MessageText'
import { useI18n } from '../i18n/useI18n'
import { runsApi } from '../runs/api'
import {
  missionsApi,
  type Mission,
  type MissionEntry,
} from './api'

/** One orchestrator turn, followed from its run's events. */
function AgentTurn({ runId }: { runId: number }) {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [tools, setTools] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState(true)

  useEffect(() => {
    const abort = new AbortController()
    setText('')
    setTools([])
    setError(null)
    setActive(true)
    void (async () => {
      try {
        for await (const event of runsApi.follow(runId, abort.signal)) {
          if (event.type === 'text' && !event.delegation) setText((value) => value + event.text)
          if (event.type === 'tool') {
            setTools((list) => [...list, event.target ? `${event.name} ${event.target}` : event.name])
          }
          if (event.type === 'error') setError(event.message)
          if (event.type === 'finished') setActive(false)
        }
      } catch (err) {
        if (!abort.signal.aborted) setError(err instanceof Error ? err.message : t('error.unexpected'))
      } finally {
        if (!abort.signal.aborted) setActive(false)
      }
    })()
    return () => abort.abort()
  }, [runId, t])

  return (
    <div className="message assistant mission-turn">
      {tools.length > 0 && (
        <ul className="tools">
          {tools.map((tool, i) => (
            <li key={i}>{tool}</li>
          ))}
        </ul>
      )}
      {text ? <MessageText text={text} /> : active ? <p className="hint">{t('missions.thinking')}</p> : null}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

interface Props {
  mission: Mission
  entries: MissionEntry[]
  onChanged: () => Promise<unknown>
}

/** The briefing: the conversation, the questions and the note box. */
export function BriefingView({ mission, entries, onChanged }: Props) {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [entries])

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

  async function send(value: string) {
    if (sending || (!value.trim() && !attachments.length)) return
    setSending(true)
    setError(null)
    try {
      await missionsApi.messages(mission.id, {
        text: value,
        attachments: attachments.length ? attachments : undefined,
      })
      setText('')
      setAttachments([])
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.unexpected'))
    } finally {
      setSending(false)
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    void send(text)
  }

  const canWrite = mission.status === 'briefing' || mission.status === 'planned'

  return (
    <section className="card mission-briefing">
      <header className="row spread">
        <h2>{t('missions.briefing')}</h2>
        <span className="badge">{t('missions.briefingHint')}</span>
      </header>
      <div className="messages" ref={listRef}>
        {entries.map((entry) => {
          if (entry.kind === 'note') {
            const files = Array.isArray(entry.data.attachments)
              ? (entry.data.attachments as { name: string }[])
              : []
            return (
              <div className="message user" key={entry.id}>
                <MessageText text={String(entry.data.text ?? '')} />
                {files.length > 0 && (
                  <ul className="tools">
                    {files.map((file, i) => (
                      <li key={`${file.name}-${i}`}>{file.name}</li>
                    ))}
                  </ul>
                )}
              </div>
            )
          }
          if (entry.kind === 'turn') {
            const runId = Number(entry.data.runId)
            return <AgentTurn key={entry.id} runId={runId} />
          }
          if (entry.kind === 'question') {
            const options = Array.isArray(entry.data.options)
              ? (entry.data.options as string[])
              : []
            const pending = mission.wait?.entryId === entry.id
            return (
              <div className="message assistant mission-question" key={entry.id}>
                <MessageText text={String(entry.data.question ?? '')} />
                {pending && options.length > 0 && (
                  <div className="mission-options">
                    <p className="hint">{t('missions.chooseOption')}</p>
                    {options.map((option) => (
                      <button
                        type="button"
                        className="secondary"
                        key={option}
                        disabled={sending}
                        onClick={() => void send(option)}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          }
          return null
        })}
        {entries.length === 0 && <p className="hint">{t('missions.thinking')}</p>}
      </div>

      {canWrite && (
        <form className="composer mission-composer" onSubmit={submit}>
          {attachments.length > 0 && (
            <ul className="attachments">
              {attachments.map((a, i) => (
                <li className="attachment" key={`${a.name}-${i}`} title={a.name}>
                  <span className="name">{a.name}</span>
                  <button
                    type="button"
                    className="remove"
                    aria-label={t('chat.removeAttachment', { name: a.name })}
                    onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="composer-box">
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
            <button
              type="button"
              className="icon attach"
              aria-label={t('chat.attach')}
              title={t('chat.attach')}
              disabled={sending || attachments.length >= MAX_ATTACHMENTS}
              onClick={() => fileRef.current?.click()}
            >
              +
            </button>
            <textarea
              id="mission-input"
              value={text}
              rows={1}
              placeholder={
                mission.status === 'planned'
                  ? t('missions.commentPlaceholder')
                  : t('missions.answerPlaceholder')
              }
              onChange={(e) => setText(e.target.value)}
            />
            <button type="submit" disabled={sending || (!text.trim() && !attachments.length)}>
              {t(sending ? 'missions.sending' : mission.status === 'planned' ? 'missions.comment' : 'missions.send')}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
