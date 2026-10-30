import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/useI18n'

interface Props {
  /** Workflows the project has on. */
  workflows: { key: string }[]
  /** Chosen workflow; '' sends the message as a plain chat turn. */
  value: string
  disabled?: boolean
  onChange: (key: string) => void
}

/**
 * The workflow the next message starts, from the chat's heading: the composer
 * keeps only the model, so the choice sits with the conversation.
 */
export function WorkflowMenu({ workflows, value, disabled, onChange }: Props) {
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

  function choose(key: string) {
    setOpen(false)
    onChange(key)
  }

  return (
    <div className="menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={value ? 'icon workflow-menu chosen' : 'icon workflow-menu'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('workflows.label')}
        title={value ? t('workflows.option', { key: value }) : t('workflows.none')}
        disabled={disabled}
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
          <rect x="3" y="4" width="7" height="6" rx="1.5" />
          <rect x="14" y="14" width="7" height="6" rx="1.5" />
          <path d="M6.5 10v4a3 3 0 0 0 3 3H14" />
        </svg>
      </button>
      {open && (
        <div
          className="menu-popover below"
          role="menu"
          aria-label={t('workflows.label')}
          ref={popover}
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={value === ''}
            className="menu-item"
            onClick={() => choose('')}
          >
            <span className="text">{t('workflows.none')}</span>
          </button>
          {workflows.map((w) => (
            <button
              key={w.key}
              type="button"
              role="menuitemradio"
              aria-checked={value === w.key}
              className="menu-item"
              onClick={() => choose(w.key)}
            >
              <span className="text">{t('workflows.option', { key: w.key })}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
