import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import type { AgentResource } from './api'

interface Props {
  /** Agents switched on in the project. */
  agents: AgentResource[]
  /** Chosen agent; '' chats with the model directly. */
  value: string
  onChange: (key: string) => void
}

/**
 * The agent the chat delegates to, from the workspace bar: the composer keeps
 * only the model, so the choice sits with the project rather than the message.
 */
export function AgentMenu({ agents, value, onChange }: Props) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  const chosen = agents.find((a) => a.key === value)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus()
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
      root.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus()
  }, [open])

  return (
    <div className="menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={chosen ? 'icon agent-menu chosen' : 'icon agent-menu'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('chat.agentLabel')}
        title={chosen ? chosen.key : t('chat.directOption')}
        onClick={() => setOpen((shown) => !shown)}
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="4" y="8" width="16" height="11" rx="3" />
          <path d="M12 4v4M8.5 13h.01M15.5 13h.01" />
        </svg>
      </button>
      {open && (
        <div className="menu-popover below agents" role="menu" aria-label={t('chat.agentLabel')}>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={value === ''}
            className="menu-item"
            onClick={() => {
              setOpen(false)
              onChange('')
            }}
          >
            <span className="text">{t('chat.directOption')}</span>
          </button>
          {agents.map((a) => (
            <button
              key={a.key}
              type="button"
              role="menuitemradio"
              aria-checked={value === a.key}
              className="menu-item"
              onClick={() => {
                setOpen(false)
                onChange(a.key)
              }}
            >
              <span className="text">
                {a.key}
                <small className="desc">{a.description}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
