import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { FILE_ACCESS_LABEL } from '../agents/labels'
import type { AgentResource } from '../agents/api'
import type { ClaudeSessionInfo, RateLimitSnapshot } from '../claude/api'
import { chatApi, type Workspace } from './api'
import {
  ACCEPT,
  MAX_ATTACHMENTS,
  isImage,
  previewUrl,
  readAttachment,
  type Attachment,
} from './attachments'

interface Tool {
  name: string
  target: string | null
}

interface Message {
  id: number
  role: 'user' | 'assistant'
  text: string
  attachments?: Attachment[]
  tools: Tool[]
  error?: string
  meta?: string
  streaming?: boolean
}

/** Shows a tool target relative to the workspace when it lies inside it. */
function shortTarget(target: string, root: string) {
  return target.startsWith(`${root}/`) ? target.slice(root.length + 1) : target
}

/** Agent the chat starts with, when the project has it. */
const DEFAULT_AGENT = 'assistant'

interface Props {
  projectId: number
  /** Project folder the agent works in. */
  path: string
  /** Agents switched on in the project. */
  agents: AgentResource[]
  session: ClaudeSessionInfo
  onUsage: (rateLimits: RateLimitSnapshot) => void
}

/** Chat with Claude Code inside one folder; remount it (key) to switch folders. */
export function ChatPanel({ projectId, path, agents, session, onUsage }: Props) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [model, setModel] = useState('')
  const [agentKey, setAgentKey] = useState(() =>
    agents.some((a) => a.key === DEFAULT_AGENT) ? DEFAULT_AGENT : (agents[0]?.key ?? ''),
  )
  const agent = agents.find((a) => a.key === agentKey)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const nextId = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /** Follow new output only while the user is at the bottom, so scrolling up to read isn't undone. */
  const stickRef = useRef(true)

  useEffect(() => {
    const list = listRef.current
    if (list && stickRef.current) list.scrollTop = list.scrollHeight
  }, [messages])

  // Grow the textarea with its content, up to the CSS max-height.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [input])

  function onScroll() {
    const list = listRef.current
    if (list) stickRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48
  }

  useEffect(() => () => abortRef.current?.abort(), [])

  useEffect(() => {
    chatApi.workspace(path).then(setWorkspace, (err: unknown) =>
      setWorkspaceError(err instanceof Error ? err.message : 'Cartella non valida'),
    )
  }, [path])

  function update(id: number, change: (m: Message) => Message) {
    setMessages((list) => list.map((m) => (m.id === id ? change(m) : m)))
  }

  async function attach(files: Iterable<File>) {
    setAttachError(null)
    const list = [...files]
    const room = MAX_ATTACHMENTS - attachments.length
    if (list.length > room) setAttachError(`Al massimo ${MAX_ATTACHMENTS} allegati per messaggio`)
    const results = await Promise.allSettled(list.slice(0, Math.max(room, 0)).map(readAttachment))
    const read = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    const failed = results.find((r) => r.status === 'rejected')
    if (failed) setAttachError(failed.reason instanceof Error ? failed.reason.message : 'Allegato non valido')
    setAttachments((current) => [...current, ...read].slice(0, MAX_ATTACHMENTS))
    inputRef.current?.focus()
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...e.clipboardData.files]
    if (files.length === 0) return
    e.preventDefault()
    void attach(files)
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragging(false)
    if (workspace && !streaming) void attach(e.dataTransfer.files)
  }

  async function send() {
    const text = input.trim()
    const files = attachments
    if (!workspace || !agent || (!text && files.length === 0) || streaming) return
    const userId = nextId.current++
    const replyId = nextId.current++
    setMessages((list) => [
      ...list,
      { id: userId, role: 'user', text, attachments: files, tools: [] },
      { id: replyId, role: 'assistant', text: '', tools: [], streaming: true },
    ])
    setInput('')
    setAttachments([])
    setAttachError(null)
    stickRef.current = true
    setStreaming(true)
    const abort = new AbortController()
    abortRef.current = abort

    try {
      const events = chatApi.send(
        {
          projectId,
          agent: agent.key,
          message: text,
          attachments: files.length ? files : undefined,
          sessionId,
          model: model || undefined,
        },
        abort.signal,
      )
      for await (const event of events) {
        switch (event.type) {
          case 'session':
            setSessionId(event.sessionId)
            break
          case 'text':
            update(replyId, (m) => ({ ...m, text: m.text + event.text }))
            break
          case 'tool':
            update(replyId, (m) => ({
              ...m,
              tools: [...m.tools, { name: event.name, target: event.target }],
            }))
            break
          case 'usage':
            onUsage(event.rateLimits)
            break
          case 'error':
            update(replyId, (m) => ({ ...m, error: event.message }))
            break
          case 'done':
            update(replyId, (m) => ({
              ...m,
              meta: `${(event.durationMs / 1000).toFixed(1)}s · ${event.turns} turni`,
              error: event.isError ? (m.error ?? 'La risposta si è interrotta') : m.error,
            }))
            break
        }
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        update(replyId, (m) => ({
          ...m,
          error: err instanceof Error ? err.message : 'Invio non riuscito',
        }))
      }
    } finally {
      update(replyId, (m) => ({
        ...m,
        streaming: false,
        error: abort.signal.aborted && !m.meta ? 'Interrotta' : m.error,
      }))
      setStreaming(false)
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    void send()
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  function newConversation() {
    setSessionId(undefined)
    setMessages([])
  }

  /** A conversation belongs to one agent: switching starts a new one. */
  function switchAgent(key: string) {
    setAgentKey(key)
    newConversation()
  }

  return (
    <section
      className={dragging ? 'card chat dragging' : 'card chat'}
      aria-label="Chat"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <div className="chat-head">
        <h2>Chat</h2>
        {workspace && workspace.entries.length > 0 && (
          <small className="entries" title={workspace.entries.map((e) => e.name).join(', ')}>
            {workspace.entries
              .slice(0, 6)
              .map((e) => (e.dir ? `${e.name}/` : e.name))
              .join(', ')}
            {workspace.entries.length > 6 && ', …'}
          </small>
        )}
        {sessionId && (
          <button type="button" className="link" disabled={streaming} onClick={newConversation}>
            Nuova conversazione
          </button>
        )}
      </div>

      {workspaceError && (
        <p className="error" role="alert">
          {workspaceError}
        </p>
      )}

      {workspace && (
        <>
          <div className="messages" aria-live="polite" ref={listRef} onScroll={onScroll}>
            {messages.length === 0 && (
              <div className="chat-empty hint">
                {agent ? (
                  <>
                    <p>
                      <strong>{agent.key}</strong>: {agent.description}
                    </p>
                    <p>
                      File: {FILE_ACCESS_LABEL[agent.effective.files]}, solo in{' '}
                      <code>{workspace.path}</code>
                    </p>
                  </>
                ) : (
                  <p>Nessun agente attivo in questo progetto. Attivane uno in «Agenti e risorse».</p>
                )}
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`message ${m.role}`}>
                {m.tools.length > 0 && (
                  <ul className="tools">
                    {m.tools.map((t, i) => (
                      <li key={i}>
                        {t.name}
                        {t.target && <code>{shortTarget(t.target, workspace.path)}</code>}
                      </li>
                    ))}
                  </ul>
                )}
                {m.attachments && m.attachments.length > 0 && (
                  <AttachmentList attachments={m.attachments} />
                )}
                {m.text && <div className="bubble">{m.text}</div>}
                {m.streaming && !m.text && <div className="bubble typing">Sto pensando…</div>}
                {m.error && (
                  <p className="error" role="alert">
                    {m.error}
                  </p>
                )}
                {m.meta && <small>{m.meta}</small>}
              </div>
            ))}
          </div>

          <form className="composer" onSubmit={onSubmit}>
            {attachments.length > 0 && (
              <AttachmentList
                attachments={attachments}
                onRemove={(i) => setAttachments((list) => list.filter((_, j) => j !== i))}
              />
            )}
            {attachError && (
              <p className="error" role="alert">
                {attachError}
              </p>
            )}
            <div className="composer-box">
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                accept={ACCEPT}
                onChange={(e) => {
                  if (e.target.files) void attach(e.target.files)
                  e.target.value = ''
                }}
              />
              <button
                type="button"
                className="icon attach"
                aria-label="Allega immagini o documenti"
                title="Allega immagini o documenti"
                disabled={streaming || attachments.length >= MAX_ATTACHMENTS}
                onClick={() => fileRef.current?.click()}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path
                    d="M21 11.5l-8.6 8.6a5 5 0 01-7.1-7.1l8.6-8.6a3.3 3.3 0 014.7 4.7l-8.6 8.6a1.7 1.7 0 01-2.4-2.4l7.9-7.9"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <textarea
                ref={inputRef}
                rows={1}
                autoFocus
                aria-label="Messaggio"
                placeholder="Scrivi un messaggio…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
              />
              {streaming ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => abortRef.current?.abort()}
                >
                  Interrompi
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!agent || (!input.trim() && attachments.length === 0)}
                >
                  Invia
                </button>
              )}
            </div>
            <div className="row">
              <select
                aria-label="Agente"
                value={agentKey}
                disabled={streaming || agents.length === 0}
                onChange={(e) => switchAgent(e.target.value)}
              >
                {agents.map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.key} · {FILE_ACCESS_LABEL[a.effective.files]}
                  </option>
                ))}
              </select>
              <select
                aria-label="Modello"
                value={model}
                disabled={streaming}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="">{agent?.model ? `Modello dell'agente (${agent.model})` : 'Modello predefinito'}</option>
                {session.models
                  .filter((m) => m.value !== 'default')
                  .map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.displayName}
                    </option>
                  ))}
              </select>
              <small>Invio per inviare, Maiusc+Invio per andare a capo · trascina o incolla file</small>
            </div>
          </form>
        </>
      )}
    </section>
  )
}

function AttachmentList({
  attachments,
  onRemove,
}: {
  attachments: Attachment[]
  onRemove?: (index: number) => void
}) {
  return (
    <ul className="attachments">
      {attachments.map((a, i) => (
        <li key={i} className={isImage(a) ? 'attachment image' : 'attachment'} title={a.name}>
          {isImage(a) ? (
            <img src={previewUrl(a)} alt={a.name} />
          ) : (
            <>
              <span className="ext">{a.mediaType === 'application/pdf' ? 'PDF' : 'TXT'}</span>
              <span className="name">{a.name}</span>
            </>
          )}
          {onRemove && (
            <button
              type="button"
              className="remove"
              aria-label={`Rimuovi ${a.name}`}
              onClick={() => onRemove(i)}
            >
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}
