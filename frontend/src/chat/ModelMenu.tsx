import { useEffect, useRef, useState } from 'react'
import type { MessageKey } from '../i18n/messages'
import { useI18n } from '../i18n/useI18n'

/** A model the connected providers offer. */
export interface ModelOption {
  /** What the chat sends: provider and model id. */
  value: string
  label: string
  /** Provider the model comes from. */
  group?: string
}

/** Names and descriptions of the effort levels the providers use. */
const EFFORT_NAME: Record<string, MessageKey> = {
  low: 'effort.low',
  medium: 'effort.medium',
  high: 'effort.high',
  xhigh: 'effort.xhigh',
  max: 'effort.max',
}

const EFFORT_DESC: Record<string, MessageKey> = {
  low: 'effort.lowDesc',
  medium: 'effort.mediumDesc',
  high: 'effort.highDesc',
  xhigh: 'effort.xhighDesc',
  max: 'effort.maxDesc',
}

interface Props {
  /** Models to offer, the default one left out. */
  models: ModelOption[]
  /** Label of the default choice: the agent's model, or the generic default. */
  defaultLabel: string
  /** Chosen model; '' is the default one. */
  model: string
  /** Effort levels the chosen model accepts; none hides the reasoning level. */
  efforts: string[]
  /** Chosen effort; '' leaves it to the model. */
  effort: string
  disabled?: boolean
  onModel: (value: string) => void
  onEffort: (value: string) => void
}

/**
 * The model and its reasoning level in one pill, opening the list of models
 * and, under it, the levels the chosen one accepts.
 */
export function ModelMenu({
  models,
  defaultLabel,
  model,
  efforts,
  effort,
  disabled,
  onModel,
  onEffort,
}: Props) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [reasoning, setReasoning] = useState(false)
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)

  const chosen = models.find((m) => m.value === model)

  /** Name of a level, the raw value when it isn't one the providers share. */
  const levelName = (value: string) =>
    EFFORT_NAME[value] ? t(EFFORT_NAME[value]) : value

  function close() {
    setOpen(false)
    setReasoning(false)
    setQuery('')
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      setReasoning(false)
      setQuery('')
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
    // On touch screens focusing opens the keyboard, which shrinks the viewport
    // and pushes the list out of view: there the user taps the search field.
    const touch = window.matchMedia('(pointer: coarse)').matches
    if (open && !touch) search.current?.focus()
  }, [open])

  const q = query.trim().toLowerCase()
  const match = (o: ModelOption) =>
    !q ||
    o.label.toLowerCase().includes(q) ||
    (o.group?.toLowerCase().includes(q) ?? false)

  const options: ModelOption[] = [
    { value: '', label: defaultLabel },
    ...models,
  ].filter(match)

  return (
    <div className="menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="model-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="name">{chosen?.label ?? defaultLabel}</span>
        {effort && <span className="level">{levelName(effort)}</span>}
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 15l6-6 6 6" />
        </svg>
      </button>
      {open && !disabled && (
        <div className="menu-popover above model-popover" role="menu" aria-label={t('chat.modelLabel')}>
          <input
            ref={search}
            type="search"
            className="model-search"
            aria-label={t('chat.searchModels')}
            placeholder={t('chat.searchModels')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // The composer is a form: Enter filters, it doesn't send the message.
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault()
            }}
          />
          <div className="menu-list">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="menuitemradio"
                aria-checked={o.value === model}
                className="menu-item"
                onClick={() => {
                  onModel(o.value)
                  close()
                }}
              >
                <span className="text">
                  {o.label}
                  <small className="desc">
                    {o.value === '' ? t('chat.defaultModelDesc') : o.group}
                  </small>
                </span>
              </button>
            ))}
            {options.length === 0 && <p className="menu-empty hint">{t('chat.noMatches')}</p>}
          </div>
          {efforts.length > 0 && (
            <>
              <div className="menu-separator" role="separator" />
              <button
                type="button"
                className="menu-item submenu"
                aria-haspopup="menu"
                aria-expanded={reasoning}
                onClick={() => setReasoning((shown) => !shown)}
              >
                <span className="text">{t('chat.reasoningLevel')}</span>
                <svg
                  className="trail"
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M9 5l7 7-7 7" />
                </svg>
              </button>
              {reasoning && (
                <div className="menu-popover sub" role="menu" aria-label={t('chat.effortLabel')}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={effort === ''}
                    className="menu-item"
                    onClick={() => {
                      onEffort('')
                      close()
                    }}
                  >
                    <span className="text">
                      {t('chat.defaultEffort')}
                      <small className="desc">{t('effort.defaultDesc')}</small>
                    </span>
                  </button>
                  {efforts.map((level) => (
                    <button
                      key={level}
                      type="button"
                      role="menuitemradio"
                      aria-checked={effort === level}
                      className="menu-item"
                      onClick={() => {
                        onEffort(level)
                        close()
                      }}
                    >
                      <span className="text">
                        {levelName(level)}
                        {EFFORT_DESC[level] && (
                          <small className="desc">{t(EFFORT_DESC[level])}</small>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
