import { useState, type ReactNode } from 'react'
import { resourcesApi, type AgentResource, type ProjectResources, type ResourceKind } from './api'
import { FILE_ACCESS_LABEL } from './labels'

interface Props {
  projectId: number
  resources: ProjectResources
  /** Called after a switch so the workspace reloads what the project has on. */
  onChange: () => void
}

interface Item {
  key: string
  description: string
  enabled: boolean
}

/** Catalog resources of one project, each with its on/off switch. Definitions live in backend/catalog. */
export function ResourcesPanel({ projectId, resources, onChange }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function toggle(kind: ResourceKind, item: Item) {
    const id = `${kind}:${item.key}`
    setBusy(id)
    setError(null)
    try {
      await resourcesApi.set(projectId, kind, item.key, !item.enabled)
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Modifica non riuscita')
    } finally {
      setBusy(null)
    }
  }

  function section(
    title: string,
    kind: ResourceKind,
    items: Item[],
    extra?: (item: Item) => ReactNode,
  ) {
    return (
      <section className="resource-section">
        <h3>{title}</h3>
        {items.length === 0 ? (
          <p className="hint">Nessuno nella libreria.</p>
        ) : (
          <ul className="resource-list">
            {items.map((item) => (
              <li key={item.key} className={item.enabled ? '' : 'off'}>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={item.enabled}
                    disabled={busy !== null}
                    onChange={() => void toggle(kind, item)}
                  />
                  <strong>{item.key}</strong>
                </label>
                <span className="hint">{item.description}</span>
                {extra?.(item)}
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  }

  return (
    <div className="card resources">
      <p className="hint">
        Le risorse si creano e modificano in <a href="#/resources">Risorse</a>. Qui scegli cosa è
        attivo in questo progetto: un agente riceve solo i suoi permessi, limitati a ciò che è
        attivo.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {section('Agenti', 'agent', resources.agents, (item) => (
        <AgentPermissions agent={item as AgentResource} />
      ))}
      {section('Workflow', 'workflow', resources.workflows)}
      {section('Tool', 'tool', resources.tools)}
      {section('Server MCP', 'mcp', resources.mcp)}
      {section('Skill', 'skill', resources.skills)}
    </div>
  )
}

function AgentPermissions({ agent }: { agent: AgentResource }) {
  const { permissions: asked, effective } = agent
  const lists = [
    ['tool', asked.tools, effective.tools],
    ['MCP', asked.mcp, effective.mcp],
    ['skill', asked.skills, effective.skills],
  ] as const
  return (
    <ul className="tools permissions">
      <li>file: {FILE_ACCESS_LABEL[effective.files]}</li>
      {agent.model && <li>modello: {agent.model}</li>}
      {lists.flatMap(([label, all, granted]) =>
        all.map((key) => (
          <li
            key={`${label}:${key}`}
            className={granted.includes(key) ? '' : 'off'}
            title={granted.includes(key) ? undefined : 'Non attivo in questo progetto'}
          >
            {label}: {key}
          </li>
        )),
      )}
    </ul>
  )
}
