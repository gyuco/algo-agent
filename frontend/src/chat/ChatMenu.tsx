import { useEffect, useRef, useState } from 'react'
import type { AgentResource } from '../agents/api'
import type { MessageKey } from '../i18n/messages'
import { useI18n } from '../i18n/useI18n'
import type { WorkspaceView } from '../projects/workspaceViews'

interface Props {
  /** Agents switched on in the project, to choose who answers. */
  agents: AgentResource[]
  /** Chosen agent, '' chats with the model directly. */
  agent: string
  onAgent: (key: string) => void
  /** Workflows switched on in the project, to run from the next message. */
  workflows: { key: string }[]
  /** Chosen workflow, '' sends a plain chat turn. */
  workflow: string
  onWorkflow: (key: string) => void
  workflowsDisabled?: boolean
  /** Views of the workspace, and the one showing now. */
  views: { key: WorkspaceView; label: MessageKey }[]
  view: WorkspaceView
  onView: (view: WorkspaceView) => void
  /** Past conversations shown in place of the chat. */
  historyOpen: boolean
  onHistory: () => void
  onNew: () => void
  /** Opens the file picker for the attachments. */
  onAttach: () => void
  attachDisabled?: boolean
  /** Mission the conversation belongs to, or the one it can become. */
  missionHref?: string
  onTransform?: () => void
}

/**
 * The composer's "+": every action of the chat as text, instead of a row of
 * icons above the conversation.
 */
export function ChatMenu({
  agents,
  agent,
  onAgent,
  workflows,
  workflow,
  onWorkflow,
  workflowsDisabled,
  views,
  view,
  onView,
  historyOpen,
  onHistory,
  onNew,
  onAttach,
  attachDisabled,
  missionHref,
  onTransform,
}: Props) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)

  const close = () => setOpen(false)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        trigger.current?.focus()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const items = popover.current?.querySelectorAll<HTMLElement>(
        '[role^="menuitem"]:not([disabled])',
      )
      if (!items?.length) return
      e.preventDefault()
      const list = Array.from(items)
      const index = list.indexOf(document.activeElement as HTMLElement)
      const next =
        e.key === 'ArrowDown'
          ? (index + 1) % list.length
          : (index - 1 + list.length) % list.length
      list[index === -1 ? 0 : next]?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (open)
      popover.current
        ?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])')
        ?.focus()
  }, [open])

  return (
    <div className="menu chat-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="composer-plus"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('chat.actions')}
        title={t('chat.actions')}
        onClick={() => setOpen((shown) => !shown)}
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      {open && (
        <div
          className="menu-popover above chat-actions"
          role="menu"
          aria-label={t('chat.actions')}
          ref={popover}
        >
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={attachDisabled}
            onClick={() => {
              close()
              onAttach()
            }}
          >
            <span className="text">{t('chat.attach')}</span>
          </button>

          <div className="menu-separator" role="separator" />
          <p className="menu-heading" role="presentation">
            {t('chat.agentLabel')}
          </p>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={agent === ''}
            className="menu-item"
            onClick={() => {
              close()
              onAgent('')
            }}
          >
            <span className="text">{t('chat.directOption')}</span>
          </button>
          {agents.map((a) => (
            <button
              key={a.key}
              type="button"
              role="menuitemradio"
              aria-checked={agent === a.key}
              className="menu-item"
              onClick={() => {
                close()
                onAgent(a.key)
              }}
            >
              <span className="text">
                {a.key}
                <small className="desc">{a.description}</small>
              </span>
            </button>
          ))}

          {workflows.length > 0 && (
            <>
              <div className="menu-separator" role="separator" />
              <p className="menu-heading" role="presentation">
                {t('workflows.label')}
              </p>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={workflow === ''}
                className="menu-item"
                disabled={workflowsDisabled}
                onClick={() => {
                  close()
                  onWorkflow('')
                }}
              >
                <span className="text">{t('workflows.none')}</span>
              </button>
              {workflows.map((w) => (
                <button
                  key={w.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={workflow === w.key}
                  className="menu-item"
                  disabled={workflowsDisabled}
                  onClick={() => {
                    close()
                    onWorkflow(w.key)
                  }}
                >
                  <span className="text">{t('workflows.option', { key: w.key })}</span>
                </button>
              ))}
            </>
          )}

          <div className="menu-separator" role="separator" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={historyOpen}
            className="menu-item"
            onClick={() => {
              close()
              onHistory()
            }}
          >
            <span className="text">{t('chat.history')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              close()
              onNew()
            }}
          >
            <span className="text">{t('chat.newConversation')}</span>
          </button>

          <div className="menu-separator" role="separator" />
          <p className="menu-heading" role="presentation">
            {t('workspace.views')}
          </p>
          {views.map((option) => (
            <button
              key={option.key}
              type="button"
              role="menuitemradio"
              aria-checked={view === option.key}
              className="menu-item"
              onClick={() => {
                close()
                onView(option.key)
              }}
            >
              <span className="text">{t(option.label)}</span>
            </button>
          ))}

          {(missionHref || onTransform) && (
            <>
              <div className="menu-separator" role="separator" />
              {missionHref && (
                <a role="menuitem" className="menu-item" href={missionHref} onClick={close}>
                  <span className="text">{t('missions.open')}</span>
                </a>
              )}
              {onTransform && (
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    close()
                    onTransform()
                  }}
                >
                  <span className="text">{t('missions.transform')}</span>
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
