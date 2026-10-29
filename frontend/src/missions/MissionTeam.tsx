import { useI18n } from '../i18n/useI18n'
import type { Mission } from './api'

/** Who works on the mission: the orchestrator, each role of the plan and the custom agents, with their model. */
export function MissionTeam({ mission }: { mission: Mission }) {
  const { t } = useI18n()
  const team = mission.plan?.team
  if (!team) return null
  return (
    <section className="card mission-team">
      <h3>{t('missions.teamTitle')}</h3>
      <ul>
        <li>
          <strong>{t('missions.orchestrator')}</strong>
          <code className="model-chip">{mission.orchestratorModel}</code>
          <span className="hint">{t('missions.teamOrchestratorHint')}</span>
        </li>
        {Object.entries(team.roles).map(([role, spec]) => (
          <li key={role}>
            <strong>{spec.agent}</strong>
            <code className="model-chip">{spec.model}</code>
            <span className="hint">{t('missions.teamRole', { role })}</span>
          </li>
        ))}
        {team.custom.map((agent) => (
          <li key={agent.key}>
            <strong>{agent.key}</strong>
            <code className="model-chip">{agent.model}</code>
            <span className="hint">{agent.description}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
