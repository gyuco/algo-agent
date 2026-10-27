import { useCallback, useEffect, useState } from 'react'
import { resourcesApi, type ProjectResources } from '../agents/api'
import { ResourcesPanel } from '../agents/ResourcesPanel'
import { ChatPanel } from '../chat/ChatPanel'
import type { ClaudeStatusState } from '../claude/useClaudeStatus'
import { useI18n } from '../i18n/useI18n'
import { WorkflowsPanel } from '../workflows/WorkflowsPanel'
import { projectsApi, type Project } from './api'

interface Props {
  projectId: number
  claude: ClaudeStatusState
}

const TABS = [
  ['chat', 'Chat'],
  ['workflows', 'Workflow'],
  ['resources', 'Agenti e risorse'],
] as const
type Tab = (typeof TABS)[number][0]

/** One project's workspace: chat, workflows and the agents it has on. Key it by project. */
export function ProjectWorkspace({ projectId, claude }: Props) {
  const { t } = useI18n()
  const [project, setProject] = useState<Project | null>(null)
  const [resources, setResources] = useState<ProjectResources | null>(null)
  const [tab, setTab] = useState<Tab>('chat')
  /** '' means a failure without a server message. */
  const [error, setError] = useState<string | null>(null)
  const { status } = claude

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : '')

  useEffect(() => {
    projectsApi.get(projectId).then(setProject, fail)
  }, [projectId])

  const loadResources = useCallback(() => {
    resourcesApi.list(projectId).then(setResources, fail)
  }, [projectId])

  useEffect(loadResources, [loadResources])

  const connected = status?.connected && status.session
  const agents = resources?.agents.filter((a) => a.enabled) ?? []
  /** Remounts the chat when the set of agents changes, so it never keeps a disabled one. */
  const agentsKey = agents.map((a) => a.key).join(',')

  return (
    <>
      <div className="workspace-head">
        <a className="back" href="#/">
          ← {t('nav.home')}
        </a>
        {project && (
          <>
            <h1>{project.name}</h1>
            <code className="hint">{project.path}</code>
          </>
        )}
      </div>
      {error !== null && (
        <p className="error" role="alert">
          {error || t('workspace.loadError')}
        </p>
      )}
      {(!project || !resources) && error === null && <p className="hint">{t('projects.loading')}</p>}
      {project && resources && (
        <>
          <div className="tabs" role="tablist">
            {TABS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? 'tab active' : 'tab'}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          {!connected && tab !== 'resources' && !claude.checking && (
            <p className="hint">
              {t('workspace.connectFirst')} <a href="#/">{t('nav.home')}</a>
            </p>
          )}
          {/* Panels stay mounted while hidden, so switching tab doesn't stop a running turn. */}
          {connected && (
            <div className="tab-panel" hidden={tab !== 'chat'}>
              <ChatPanel
                key={`${project.id}:${agentsKey}`}
                projectId={project.id}
                path={project.path}
                agents={agents}
                session={status.session!}
                onUsage={claude.updateRateLimits}
              />
            </div>
          )}
          {connected && (
            <div className="tab-panel" hidden={tab !== 'workflows'}>
              <WorkflowsPanel
                projectId={project.id}
                workflows={resources.workflows.filter((w) => w.enabled)}
                onUsage={claude.updateRateLimits}
              />
            </div>
          )}
          <div className="tab-panel" hidden={tab !== 'resources'}>
            <ResourcesPanel projectId={project.id} resources={resources} onChange={loadResources} />
          </div>
        </>
      )}
    </>
  )
}
