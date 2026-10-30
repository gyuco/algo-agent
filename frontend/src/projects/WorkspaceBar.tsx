import { useEffect, useRef, useState } from 'react'
import type { MessageKey } from '../i18n/messages'
import { useI18n } from '../i18n/useI18n'
import { ProjectIcon } from './ProjectIcon'

/** What the workspace shows under the bar. */
export type WorkspaceView = 'chat' | 'missions' | 'resources'

const VIEWS: [WorkspaceView, MessageKey][] = [
  ['chat', 'chat.title'],
  ['missions', 'missions.title'],
  ['resources', 'workspace.tabResources'],
]

interface Props {
  name: string
  path: string
  color?: string | null
  logo?: string | null
  /** View shown now, marked in the menu. */
  view: WorkspaceView
  onOpen: (view: WorkspaceView) => void
}

/**
 * Header of the views that don't show one themselves: where the project lives
 * and what it opens. The chat keeps its own, inside the card.
 */
export function WorkspaceBar({ name, path, color, logo, view, onOpen }: Props) {
  return (
    <div className="workspace-bar">
      <ProjectIcon name={name} color={color} logo={logo} className="project-icon-sm" />
      <h1 className="workspace-title" title={name}>
        {name}
      </h1>
      <code className="workspace-path" title={path}>
        {path}
      </code>
      <div className="workspace-actions">
        <ViewMenu view={view} onOpen={onOpen} />
      </div>
    </div>
  )
}

/** Opens the views the tabs used to show: the chat, the missions, the resources. */
export function ViewMenu({ view, onOpen }: { view: WorkspaceView; onOpen: (view: WorkspaceView) => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)

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
      const items = popover.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
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
    if (open) popover.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus()
  }, [open])

  return (
    <div className="menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="icon"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('workspace.views')}
        title={t('workspace.views')}
        onClick={() => setOpen((value) => !value)}
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="16" rx="2.5" />
          <path d="M9.5 4v16" />
        </svg>
      </button>
      {open && (
        <div
          className="menu-popover below"
          role="menu"
          aria-label={t('workspace.views')}
          ref={popover}
        >
          {VIEWS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              aria-checked={view === id}
              className="menu-item"
              onClick={() => {
                setOpen(false)
                onOpen(id)
              }}
            >
              <span className="text">{t(label)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
