import type { MessageKey } from '../i18n/messages'
import type { Mission, MissionTask, TaskStatus } from './api'

/** The mission's phases, in order, as the stepper shows them. */
export const PHASES = ['briefing', 'plan', 'prepare', 'work', 'publish'] as const
export type Phase = (typeof PHASES)[number]

export const PHASE_KEY: Record<Phase, MessageKey> = {
  briefing: 'missions.phase.briefing',
  plan: 'missions.phase.plan',
  prepare: 'missions.phase.prepare',
  work: 'missions.phase.work',
  publish: 'missions.phase.publish',
}

/** Who the mission waits on: the user, the agents, the clock, or nobody. */
export type Holder = 'you' | 'agents' | 'paused' | 'done' | 'stopped'

export const HOLDER_KEY: Record<Holder, MessageKey> = {
  you: 'missions.holder.you',
  agents: 'missions.holder.agents',
  paused: 'missions.holder.paused',
  done: 'missions.holder.done',
  stopped: 'missions.holder.stopped',
}

export interface Stage {
  phase: Phase
  holder: Holder
  /** What happens now: one sentence that changes only with the state, never with the stream. */
  message: MessageKey
  params?: Record<string, string>
}

/** The phase a mission is in, from its status and its wait. */
export function missionPhase(mission: Mission): Phase {
  const code = mission.wait?.code
  switch (mission.status) {
    case 'briefing':
      return 'briefing'
    case 'planned':
      return 'plan'
    case 'approved':
      return 'prepare'
    case 'integrating':
    case 'done':
      return 'publish'
    case 'waiting':
      if (code === 'baseline') return 'prepare'
      if (code === 'final_checks' || code === 'publish') return 'publish'
      return 'work'
    case 'aborted':
      if (mission.tasks?.some((task) => task.status !== 'pending')) return 'work'
      if (mission.approvedVersion) return 'prepare'
      return mission.plan ? 'plan' : 'briefing'
    default:
      return 'work'
  }
}

const label = (task: MissionTask | undefined) => (task ? task.title || task.key : '')

/** The phase, who holds the mission and the sentence that says it. */
export function missionStage(mission: Mission): Stage {
  const phase = missionPhase(mission)
  const wait = mission.wait
  const task = mission.tasks?.find((row) => row.id === wait?.taskId)
  const you = (message: MessageKey, params?: Record<string, string>): Stage => ({
    phase,
    holder: 'you',
    message,
    params,
  })
  const agents = (message: MessageKey, params?: Record<string, string>): Stage => ({
    phase,
    holder: 'agents',
    message,
    params,
  })

  switch (mission.status) {
    case 'briefing':
      return wait?.code === 'question' ? you('missions.now.question') : agents('missions.now.briefing')
    case 'planned':
      return you('missions.now.plan')
    case 'approved':
      return agents('missions.now.prepare')
    case 'paused':
      return { phase, holder: 'paused', message: 'missions.now.paused' }
    case 'integrating':
      return agents('missions.now.integrating')
    case 'done':
      return { phase, holder: 'done', message: mission.prUrl ? 'missions.now.donePr' : 'missions.now.done' }
    case 'aborted':
      return { phase, holder: 'stopped', message: 'missions.now.aborted' }
    case 'waiting':
      switch (wait?.code) {
        case 'baseline':
          return you('missions.now.baseline')
        case 'task_review':
          return you('missions.now.review', { task: label(task) })
        case 'task_blocked':
          return you('missions.now.blocked', { task: label(task) })
        case 'scope':
          return you('missions.now.scope', { task: label(task) })
        case 'milestone':
          return you('missions.now.milestone')
        case 'revision':
          return agents('missions.now.revision')
        case 'final_checks':
          return you('missions.now.finalChecks')
        case 'publish':
          return you('missions.now.publish')
        case 'weekly_budget':
        case 'usd_budget':
          return you('missions.now.budget')
        default:
          return you('missions.now.other')
      }
  }
  const active = (mission.tasks ?? []).filter((row) => row.status === 'running' || row.status === 'merging')
  return active.length
    ? agents('missions.now.tasks', { tasks: active.map(label).join(', ') })
    : agents('missions.now.next')
}

/** How a task's state reads at a glance: working, done, failed, waiting on the user, or not yet. */
export type TaskTone = 'running' | 'done' | 'failed' | 'you' | 'pending' | 'skipped'

export const TASK_TONE: Record<TaskStatus, TaskTone> = {
  pending: 'pending',
  running: 'running',
  review: 'you',
  ready: 'pending',
  merging: 'running',
  scope: 'you',
  done: 'done',
  blocked: 'you',
  skipped: 'skipped',
  aborted: 'failed',
}
