import { useState, type ReactNode } from 'react'
import { useI18n } from '../i18n/useI18n'
import {
  resourcesApi,
  type AgentResource,
  type McpResource,
  type ProjectResources,
  type ResourceKind,
} from './api'
import { FILE_ACCESS_KEY } from './labels'

interface Props {
  projectId: number
  resources: ProjectResources
  /** Secrets runs here can use, to point out what an MCP server is missing; null while loading. */
  secretNames: string[] | null
  /** Called after a switch so the workspace reloads what the project has on. */
  onChange: () => void
}

interface Item {
  key: string
  description: string
  enabled: boolean
  own?: boolean
}

/** Catalog resources of one project, each with its on/off switch. Definitions live in backend/catalog. */
export function ResourcesPanel({ projectId, resources, secretNames, onChange }: Props) {
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

  const all = [
    resources.agents,
    resources.workflows,
    resources.tools,
    resources.mcp,
    resources.skills,
  ]
  const active = all.reduce((n, items) => n + items.filter((item) => item.enabled).length, 0)

  function section(
    title: string,
    kind: ResourceKind,
    items: Item[],
    description: string,
    extra?: (item: Item) => ReactNode,
  ) {
    const on = items.filter((item) => item.enabled).length
    return (
      <section className="resource-section">
        <div className="resource-section-head">
          <div className="grow">
            <h3>{title}</h3>
            <p className="hint">{description}</p>
          </div>
          <span className="resource-count">
            {on}/{items.length}
          </span>
        </div>
        {items.length === 0 ? (
          <p className="hint">{t('resources.none')}</p>
        ) : (
          <ul className="resource-cards">
            {items.map((item) => (
              <li key={item.key} className={item.enabled ? 'resource-card on' : 'resource-card'}>
                <label className="resource-toggle">
                  <span className="resource-main">
                    <span className="resource-title">
                      <strong>{item.key}</strong>
                      {item.own && <span className="badge accent">{t('resources.ownBadge')}</span>}
                      <span className={item.enabled ? 'resource-state on' : 'resource-state'}>
                        {t(item.enabled ? 'resources.active' : 'resources.inactive')}
                      </span>
                    </span>
                    <span className="hint resource-desc">{item.description}</span>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={item.enabled}
                    disabled={busy !== null}
                    aria-label={item.key}
                    onChange={() => void toggle(kind, item)}
                  />
                </label>
                {extra?.(item)}
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  }

  return (
    <div className="card resources resources-panel">
      <header className="resources-head">
        <div className="grow">
          <h2>{t('resources.title')}</h2>
          <p className="hint">{t('resources.introTail')}</p>
        </div>
        <a className="button secondary resources-manage" href="#/resources">
          {t('resources.manage')}
        </a>
      </header>
      <p className="resources-summary hint">
        {t('resources.summary', {
          active: String(active),
          total: String(all.reduce((n, items) => n + items.length, 0)),
        })}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {section(
        t('kind.agents'),
        'agent',
        resources.agents,
        t('resources.agentsHint'),
        (item) => <AgentPermissions agent={item as AgentResource} />,
      )}
      {section(
        t('kind.workflows'),
        'workflow',
        resources.workflows,
        t('resources.workflowsHint'),
      )}
      {section(t('kind.tools'), 'tool', resources.tools, t('resources.toolsHint'))}
      {section(
        t('kind.mcps'),
        'mcp',
        resources.mcp,
        t('resources.mcpsHint'),
        (item) => <McpNeeds mcp={item as McpResource} secretNames={secretNames} />,
      )}
      {section(t('kind.skills'), 'skill', resources.skills, t('resources.skillsHint'))}
    </div>
  )
}

function Chip({ label, children, tone }: { label: string; children: ReactNode; tone?: string }) {
  return (
    <span className={tone ? `meta-chip ${tone}` : 'meta-chip'}>
      <span className="meta-label">{label}</span>
      {children}
    </span>
  )
}

function AgentPermissions({ agent }: { agent: AgentResource }) {
  const { t } = useI18n()
  const { permissions: asked, effective } = agent
  const lists = [
    ['resources.tools', asked.tools, effective.tools],
    ['resources.mcp', asked.mcp, effective.mcp],
    ['resources.skills', asked.skills, effective.skills],
  ] as const
  const accessRank = { none: 0, read: 1, write: 2 }
  /** Permissions the agent asks for that this project doesn't grant. */
  const missing =
    (accessRank[effective.files] < accessRank[asked.files] ? 1 : 0) +
    asked.tools.filter((key) => !effective.tools.includes(key)).length +
    asked.mcp.filter((key) => !effective.mcp.includes(key)).length +
    asked.skills.filter((key) => !effective.skills.includes(key)).length

  return (
    <div className="resource-meta">
      <Chip label={t('resources.files')}>{t(FILE_ACCESS_KEY[effective.files])}</Chip>
      {agent.model && <Chip label={t('resources.model')}>{agent.model}</Chip>}
      {lists.flatMap(([labelKey, all, granted]) =>
        all
          .filter((key) => granted.includes(key))
          .map((key) => (
            <Chip key={`${labelKey}:${key}`} label={t(labelKey)}>
              {key}
            </Chip>
          )),
      )}
      {missing > 0 && (
        <span className="meta-chip muted" title={t('resources.permissionsLimitedTitle')}>
          {t(
            missing === 1
              ? 'resources.permissionsLimitedOne'
              : 'resources.permissionsLimited',
            { count: String(missing) },
          )}
        </span>
      )}
    </div>
  )
}

/** The secrets an MCP server refers to, the missing ones marked. */
function McpNeeds({ mcp, secretNames }: { mcp: McpResource; secretNames: string[] | null }) {
  const { t } = useI18n()
  if (mcp.needs.length === 0) return null
  return (
    <div className="resource-meta">
      {mcp.needs.map((name) => {
        const missing = secretNames !== null && !secretNames.includes(name)
        return (
          <Chip
            key={name}
            label={t(missing ? 'resources.secretMissing' : 'resources.secret')}
            tone={missing ? 'missing' : undefined}
          >
            <code>{name}</code>
          </Chip>
        )
      })}
    </div>
  )
}
