import { useCallback, useEffect, useState } from 'react'
import { resourcesApi, type ProjectResources } from '../agents/api'
import { ResourcesPanel } from '../agents/ResourcesPanel'
import { ChatPanel } from '../chat/ChatPanel'
import type { ConnectionsState } from '../connections/useConnections'
import { useI18n } from '../i18n/useI18n'
import { runsApi, type Run } from '../runs/api'
import type { ActiveRunsState } from '../runs/useActiveRuns'
import { LibraryPage } from '../library/LibraryPage'
import { MissionStartDialog } from '../missions/MissionStartDialog'
import { MissionsPanel } from '../missions/MissionsPanel'
import { SecretsPanel } from '../vault/SecretsPanel'
import { projectsApi, type Project } from './api'
import { WorkspaceBar } from './WorkspaceBar'
import { WORKSPACE_VIEWS, type WorkspaceView } from './workspaceViews'

interface Props {
  projectId: number
  /** Run to open: its conversation in the chat, or its mission. */
  runId?: number
  /** Mission to open in the Missions tab. */
  missionId?: number
  connections: ConnectionsState
  runs: ActiveRunsState
}

/** One project's workspace: chat (and its workflows), missions and the agents it has on. Key it by project. */
export function ProjectWorkspace({ projectId, runId, missionId, connections, runs }: Props) {
  const { t } = useI18n()
  const [project, setProject] = useState<Project | null>(null)
  const [resources, setResources] = useState<ProjectResources | null>(null)
  const [view, setView] = useState<WorkspaceView>('chat')
  /** Past conversations shown in place of the chat, from the workspace bar. */
  const [history, setHistory] = useState(false)
  /** Agent the chat uses, '' for the model alone: picked from the bar, the chat follows. */
  const [agent, setAgent] = useState('')
  const [secretNames, setSecretNames] = useState<string[] | null>(null)
  /** '' means a failure without a server message. */
  const [error, setError] = useState<string | null>(null)
  /** Conversation being turned into a mission. */
  const [transformSession, setTransformSession] = useState<string | null>(null)
  /** Mission to open in the Missions tab, e.g. the one just created. */
  const [openMission, setOpenMission] = useState<number | null>(null)

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
      // Workflow runs belong to the chat's conversations.
      setView(run.kind === 'chat' || run.kind === 'workflow' ? 'chat' : 'missions')
      if (run.kind !== 'chat' && run.kind !== 'workflow') {
        setOpenMission(run.missionId ?? null)
      }
    }, fail)
  }, [runId, projectId])

  /** A mission link from the chat opens it in the Missions tab. */
  useEffect(() => {
    if (!missionId) return
    setOpenMission(missionId)
    setView('missions')
  }, [missionId])

  /** Leaves the conversations list behind when the chat isn't shown. */
  function openView(next: WorkspaceView) {
    setView(next)
    if (next !== 'chat') setHistory(false)
  }

  const connected = connections.connected.length > 0
  const agents = resources?.agents.filter((a) => a.enabled) ?? []
  /** Remounts the chat when the set of agents changes, so it never keeps a disabled one. */
  const agentsKey = agents.map((a) => a.key).join(',')

  /** The chosen agent, ignored while it isn't one of the project's. */
  const agentKey = agents.some((a) => a.key === agent) ? agent : ''

  return (
    <>
      {/* No bar while the providers are still being checked: it would flash a
          header of a page that is about to become the chat. */}
      {project && !connections.checking && (view !== 'chat' || !connected) && (
        <WorkspaceBar
          name={project.name}
          path={project.path}
          color={project.color}
          logo={project.logo}
          view={view}
          onOpen={openView}
        />
      )}
      {error !== null && (
        <p className="error" role="alert">
          {error || t('workspace.loadError')}
        </p>
      )}
      {(!project || !resources) && error === null && <p className="hint">{t('projects.loading')}</p>}
      {project && resources && (
        <>
          {!connected && view !== 'resources' && !connections.checking && (
            <p className="hint">
              {t('workspace.connectFirst')} <a href="#/connections">{t('nav.connections')}</a>
            </p>
          )}
          {/* Panels stay mounted while hidden, so switching view doesn't stop a running turn. */}
          {connected && (
            <div className="view-panel" hidden={view !== 'chat'}>
              <ChatPanel
                key={`${project.id}:${agentsKey}`}
                projectId={project.id}
                name={project.name}
                path={project.path}
                agents={agents}
                workflows={resources.workflows.filter((w) => w.enabled && !w.task)}
                connections={connections.connected}
                onUsage={connections.updateDetails}
                runs={runs}
                open={opened?.kind === 'chat' || opened?.kind === 'workflow' ? opened : null}
                historyOpen={history}
                onHistoryOpen={setHistory}
                agent={agentKey}
                onAgentChange={setAgent}
                views={WORKSPACE_VIEWS}
                view={view}
                onView={openView}
                onTransformToMission={setTransformSession}
              />
            </div>
          )}
          {connected && (
            <div className="view-panel" hidden={view !== 'missions'}>
              <MissionsPanel
                projectId={project.id}
                initialMissionId={openMission}
                onOpened={() => setOpenMission(null)}
              />
            </div>
          )}
          <div className="view-panel library" hidden={view !== 'resources'}>
            <ResourcesPanel
              projectId={project.id}
              resources={resources}
              secretNames={secretNames}
              onChange={loadResources}
            />
            <LibraryPage projectId={project.id} onChange={loadResources} />
            <SecretsPanel projectId={project.id} onNames={setSecretNames} />
          </div>
        </>
      )}
      {project && transformSession && (
        <MissionStartDialog
          projectId={project.id}
          fromSession={transformSession}
          onClose={() => setTransformSession(null)}
          onCreated={(missionId) => {
            setTransformSession(null)
            setOpenMission(missionId)
            setView('missions')
          }}
        />
      )}
    </>
  )
}
