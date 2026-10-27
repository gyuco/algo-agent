import { useState, type ReactNode } from 'react'
import { useI18n } from '../i18n/useI18n'
import { resourcesApi, type AgentResource, type ProjectResources, type ResourceKind } from './api'
import { FILE_ACCESS_KEY } from './labels'

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
  const { t } = useI18n()
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
      setError(err instanceof Error ? err.message : t('resources.changeFailed'))
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
          <p className="hint">{t('resources.none')}</p>
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
        {t('resources.introLead')} <a href="#/resources">{t('resources.tabLink')}</a>.{' '}
        {t('resources.introTail')}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {section(t('kind.agents'), 'agent', resources.agents, (item) => (
        <AgentPermissions agent={item as AgentResource} />
      ))}
      {section(t('kind.workflows'), 'workflow', resources.workflows)}
      {section(t('kind.tools'), 'tool', resources.tools)}
      {section(t('kind.mcps'), 'mcp', resources.mcp)}
      {section(t('kind.skills'), 'skill', resources.skills)}
    </div>
  )
}

function AgentPermissions({ agent }: { agent: AgentResource }) {
  const { t } = useI18n()
  const { permissions: asked, effective } = agent
  const lists = [
    ['detail.tool', asked.tools, effective.tools],
    ['detail.mcp', asked.mcp, effective.mcp],
    ['detail.skill', asked.skills, effective.skills],
  ] as const
  return (
    <ul className="tools permissions">
      <li>{t('detail.files', { access: t(FILE_ACCESS_KEY[effective.files]) })}</li>
      {agent.model && <li>{t('detail.model', { model: agent.model })}</li>}
      {lists.flatMap(([labelKey, all, granted]) =>
        all.map((key) => (
          <li
            key={`${labelKey}:${key}`}
            className={granted.includes(key) ? '' : 'off'}
            title={granted.includes(key) ? undefined : t('resources.notActive')}
          >
            {t(labelKey, { key })}
          </li>
        )),
      )}
    </ul>
  )
}
