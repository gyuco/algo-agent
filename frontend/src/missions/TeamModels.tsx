import { useEffect, useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import { connectionsApi, type ConnectionStatus } from '../connections/api'
import { missionsApi, type Mission } from './api'

type Models = Record<string, string>

const rolesOf = (mission: Mission): Models =>
  Object.fromEntries(Object.entries(mission.plan?.team.roles ?? {}).map(([role, spec]) => [role, spec.model]))

const customOf = (mission: Mission): Models =>
  Object.fromEntries((mission.plan?.team.custom ?? []).map((agent) => [agent.key, agent.model]))

/**
 * The models the orchestrator gave the team, which the user may change before or during the mission.
 * Keyed by the plan version by its parents, so a new plan resets the choices.
 */
export function TeamModels({
  mission,
  onChanged,
  onError,
}: {
  mission: Mission
  onChanged: () => Promise<unknown>
  onError: (message: string) => void
}) {
  const { t } = useI18n()
  const [connections, setConnections] = useState<ConnectionStatus[]>([])
  const [roles, setRoles] = useState<Models>(() => rolesOf(mission))
  const [custom, setCustom] = useState<Models>(() => customOf(mission))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    void connectionsApi
      .list()
      .then((list) => {
        if (live) setConnections(list.filter((c) => c.connected))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  const plan = mission.plan
  if (!plan) return null
  const editable = ['planned', 'running', 'paused', 'waiting'].includes(mission.status)
  const changed = (next: Models, prev: Models) =>
    Object.fromEntries(Object.entries(next).filter(([k, v]) => prev[k] !== v))
  const changedRoles = changed(roles, rolesOf(mission))
  const changedCustom = changed(custom, customOf(mission))
  const dirty = Object.keys(changedRoles).length + Object.keys(changedCustom).length > 0

  async function save() {
    setBusy(true)
    try {
      await missionsApi.setTeamModels(mission.id, { roles: changedRoles, custom: changedCustom })
      await onChanged()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('error.unexpected'))
    } finally {
      setBusy(false)
    }
  }

  const offered = (value: string) => connections.some((c) => c.models.some((m) => m.value === value))
  const picker = (value: string, onPick: (model: string) => void) =>
    editable ? (
      <select value={value} disabled={busy} onChange={(e) => onPick(e.target.value)}>
        {!offered(value) && <option value={value}>{t('missions.teamUnavailable', { model: value })}</option>}
        {connections.map((c) => (
          <optgroup key={c.provider} label={c.label}>
            {c.models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.displayName}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    ) : (
      <code>{value}</code>
    )

  return (
    <div className="team-models">
      {Object.entries(plan.team.roles).map(([role, spec]) => (
        <label key={role}>
          <span>
            <strong>{role}</strong> · {spec.agent} · {t('missions.turns', { n: String(spec.maxTurns) })}
          </span>
          {picker(roles[role] ?? spec.model, (model) => setRoles({ ...roles, [role]: model }))}
        </label>
      ))}
      {plan.team.custom.map((agent) => (
        <label key={agent.key}>
          <span>
            <strong>{agent.key}</strong> · {agent.permissions.files}
          </span>
          {picker(custom[agent.key] ?? agent.model, (model) => setCustom({ ...custom, [agent.key]: model }))}
        </label>
      ))}
      {editable && dirty && (
        <div className="row end">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              setRoles(rolesOf(mission))
              setCustom(customOf(mission))
            }}
          >
            {t('missions.teamReset')}
          </button>
          <button type="button" disabled={busy} onClick={() => void save()}>
            {t('missions.teamSave')}
          </button>
        </div>
      )}
    </div>
  )
}
