import { useCallback, useEffect, useState } from 'react'
import { resourcesApi, type ProjectResources } from '../agents/api'
import { ResourcesPanel } from '../agents/ResourcesPanel'
import { ChatPanel } from '../chat/ChatPanel'
import type { ConnectionsState } from '../connections/useConnections'
import { useI18n } from '../i18n/useI18n'
import type { MessageKey } from '../i18n/messages'
import { runsApi, type Run } from '../runs/api'
import type { ActiveRunsState } from '../runs/useActiveRuns'
import { WorkflowsPanel } from '../workflows/WorkflowsPanel'
import { projectsApi, type Project } from './api'

interface Props {
  projectId: number
  /** Run to open: its conversation in the chat, or its workflow run. */
  runId?: number
  connections: ConnectionsState
  runs: ActiveRunsState
}

type Tab = 'chat' | 'workflows' | 'resources'

const TABS: [Tab, MessageKey][] = [
  ['chat', 'chat.title'],
  ['workflows', 'workspace.tabWorkflows'],
  ['resources', 'workspace.tabResources'],
]

/** One project's workspace: chat, workflows and the agents it has on. Key it by project. */
export function ProjectWorkspace({ projectId, runId, connections, runs }: Props) {
  const { t } = useI18n()
  const [project, setProject] = useState<Project | null>(null)
  const [resources, setResources] = useState<ProjectResources | null>(null)
  const [tab, setTab] = useState<Tab>('chat')
  /** '' means a failure without a server message. */
  const [error, setError] = useState<string | null>(null)

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : '')

  useEffect(() => {
    projectsApi.get(projectId).then(setProject, fail)
  }, [projectId])

  const loadResources = useCallback(() => {
    resourcesApi.list(projectId).then(setResources, fail)
  }, [projectId])

  useEffect(loadResources, [loadResources])

  /** The run the URL points at, handed to the panel that shows it. */
  const [opened, setOpened] = useState<Run | null>(null)
  useEffect(() => {
    if (!runId) return
    runsApi.get(runId).then((run) => {
      if (run.projectId !== projectId) return
      setOpened(run)
      setTab(run.kind === 'chat' ? 'chat' : 'workflows')
    }, fail)
  }, [runId, projectId])

  const connected = connections.connected.length > 0
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
            {TABS.map(([id, labelKey]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? 'tab active' : 'tab'}
                onClick={() => setTab(id)}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
          {!connected && tab !== 'resources' && !connections.checking && (
            <p className="hint">
              {t('workspace.connectFirst')} <a href="#/connections">{t('nav.connections')}</a>
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
                connections={connections.connected}
                onUsage={connections.updateDetails}
                runs={runs}
                open={opened?.kind === 'chat' ? opened : null}
              />
            </div>
          )}
          {connected && (
            <div className="tab-panel" hidden={tab !== 'workflows'}>
              <WorkflowsPanel
                projectId={project.id}
                workflows={resources.workflows.filter((w) => w.enabled)}
                onUsage={connections.updateDetails}
                runs={runs}
                open={opened?.kind === 'workflow' ? opened : null}
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
