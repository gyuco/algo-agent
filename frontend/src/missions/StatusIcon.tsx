import type { TaskTone } from './missionStage'

const GLYPH: Record<TaskTone, string> = {
  running: '',
  done: '✓',
  failed: '✕',
  you: '!',
  pending: '',
  skipped: '–',
}

/** A state at a glance: a spinner while working, a mark once settled. */
export function StatusIcon({ tone, label }: { tone: TaskTone; label?: string }) {
  return (
    <span className={`status-icon ${tone}`} role={label ? 'img' : undefined} aria-label={label} aria-hidden={!label}>
      {GLYPH[tone]}
    </span>
  )
}
