import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentMenu } from '../agents/AgentMenu'
import { resourcesApi, type ProjectResources } from '../agents/api'
import { ResourcesPanel } from '../agents/ResourcesPanel'
import { ChatPanel, type ChatPanelHandle } from '../chat/ChatPanel'
import type { ConnectionsState } from '../connections/useConnections'
import { useI18n } from '../i18n/useI18n'
import { runsApi, type Run } from '../runs/api'
import type { ActiveRunsState } from '../runs/useActiveRuns'
import { LibraryPage } from '../library/LibraryPage'
import { MissionStartDialog } from '../missions/MissionStartDialog'
import { MissionsPanel } from '../missions/MissionsPanel'
import { SecretsPanel } from '../vault/SecretsPanel'
import { projectsApi, type Project } from './api'
import { ViewMenu, WorkspaceBar, type WorkspaceView } from './WorkspaceBar'

interface Props {
  projectId: number
  /** Run to open: its conversation in the chat, or its mission. */
  runId?: number
  /** Mission to open in the Missions tab. */
  missionId?: number
  connections: ConnectionsState
  runs: ActiveRunsState
  /** Tells the top bar which project is open, for its title. */
  onProjectName?: (projectId: number, name: string) => void
}

/** One project's workspace: chat (and its workflows), missions and the agents it has on. Key it by project. */
export function ProjectWorkspace({
  projectId,
  runId,
  missionId,
  connections,
  runs,
  onProjectName,
}: Props) {
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
  /** The chat, for the bar's "new conversation". */
  const chat = useRef<ChatPanelHandle>(null)
  /** Conversation being turned into a mission. */
  const [transformSession, setTransformSession] = useState<string | null>(null)
  /** Mission to open in the Missions tab, e.g. the one just created. */
  const [openMission, setOpenMission] = useState<number | null>(null)

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : '')

  useEffect(() => {
    projectsApi.get(projectId).then((p) => {
      setProject(p)
      onProjectName?.(projectId, p.name)
    }, fail)
  }, [projectId, onProjectName])

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

  /** The chat's actions, beside the composer: the conversation has no header. */
  const chatTools = (
    <>
      <AgentMenu
        agents={agents}
        value={agentKey}
        onChange={(key) => chat.current?.selectAgent(key)}
      />
      <button
        type="button"
        className="icon"
        aria-label={t('chat.history')}
        title={t('chat.history')}
        aria-pressed={history}
        onClick={() => setHistory((shown) => !shown)}
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" />
          <path d="M3 3v5h5" />
          <path d="M12 8v4l3 2" />
        </svg>
      </button>
      <button
        type="button"
        className="icon"
        aria-label={t('chat.newConversation')}
        title={t('chat.newConversation')}
        onClick={() => chat.current?.newConversation()}
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </button>
      <ViewMenu view={view} onOpen={openView} />
    </>
  )

  return (
    <>
      {project && (view !== 'chat' || !connected) && (
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
                ref={chat}
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
                tools={chatTools}
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
