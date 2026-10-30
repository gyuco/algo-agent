import type { MessageKey } from '../i18n/messages'

/** What the workspace shows under the bar. */
export type WorkspaceView = 'chat' | 'missions' | 'resources'

/** The views a workspace can show, and their labels. */
export const WORKSPACE_VIEWS: { key: WorkspaceView; label: MessageKey }[] = [
  { key: 'chat', label: 'chat.title' },
  { key: 'missions', label: 'missions.title' },
  { key: 'resources', label: 'workspace.tabResources' },
]
