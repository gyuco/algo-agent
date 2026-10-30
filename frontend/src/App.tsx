import { useEffect, useRef, useState } from 'react'
import { LoginPage } from './auth/LoginPage'
import { ProfilePage } from './auth/ProfilePage'
import { UserMenu } from './auth/UserMenu'
import { useAuth } from './auth/useAuth'
import { LANGUAGES, type Language } from './i18n/messages'
import { useI18n } from './i18n/useI18n'
import { LibraryPage } from './library/LibraryPage'
import { ProjectCards } from './projects/ProjectCards'
import { ProjectsPage } from './projects/ProjectsPage'
import { ProjectWorkspace } from './projects/ProjectWorkspace'
import { ConnectionsBadge } from './connections/ConnectionsBadge'
import { ConnectionsPage } from './connections/ConnectionsPage'
import { useConnections, type ConnectionsState } from './connections/useConnections'
import { ActivityBadge } from './runs/ActivityBadge'
import { ActivityPage } from './runs/ActivityPage'
import { useActiveRuns, type ActiveRunsState } from './runs/useActiveRuns'
import { useMissionNotifications } from './missions/useMissionNotifications'

type Page =
  | { name: 'home' }
  | { name: 'projects' }
  | { name: 'resources' }
  | { name: 'connections' }
  | { name: 'activity' }
  | { name: 'profile' }
  /** `runId` opens that run in the project: its conversation or its workflow. */
  | { name: 'workspace'; projectId: number; runId?: number; missionId?: number }

function pageFromHash(): Page {
  const hash = window.location.hash
  if (hash === '#/projects') return { name: 'projects' }
  if (hash === '#/resources') return { name: 'resources' }
  if (hash === '#/connections') return { name: 'connections' }
  if (hash === '#/activity') return { name: 'activity' }
  if (hash === '#/profile') return { name: 'profile' }
  const workspace = /^#\/workspace\/(\d+)(?:\/run\/(\d+))?(?:\/mission\/(\d+))?$/.exec(hash)
  if (workspace) {
    return {
      name: 'workspace',
      projectId: Number(workspace[1]),
      runId: workspace[2] ? Number(workspace[2]) : undefined,
      missionId: workspace[3] ? Number(workspace[3]) : undefined,
    }
  }
  return { name: 'home' }
}

/** Current page, kept in the URL hash so reloads and back/forward work. */
function usePage(): Page {
  const [page, setPage] = useState(pageFromHash)
  useEffect(() => {
    const onChange = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return page
}

function AppHeader({
  page,
  connections,
  runs,
  missions,
  email,
  onLogout,
}: {
  page: Page
  connections: ConnectionsState
  runs: ActiveRunsState
  missions: number
  email: string
  onLogout: () => void
}) {
  const { t, language, setLanguage } = useI18n()
  /** The navigation, collapsed behind the hamburger on phones. */
  const [navOpen, setNavOpen] = useState(false)
  const header = useRef<HTMLElement>(null)
  /** The links, closed after a choice on every size. */
  const closeNav = () => setNavOpen(false)

  useEffect(() => {
    if (!navOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (!header.current?.contains(e.target as Node)) setNavOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [navOpen])

  // Back/forward and the links themselves close the menu.
  useEffect(() => {
    const close = () => setNavOpen(false)
    window.addEventListener('hashchange', close)
    return () => window.removeEventListener('hashchange', close)
  }, [])

  return (
    <header className="app-header" ref={header}>
      <a className="brand" href="#/" onClick={closeNav}>
        <span className="brand-mark" aria-hidden="true">
          a
        </span>
        algo-agent
      </a>
      <nav
        id="app-nav"
        className={navOpen ? 'open' : undefined}
        aria-label={t('nav.label')}
      >
        <ul>
          <li>
            <a
              href="#/"
              onClick={closeNav}
              aria-current={page.name === 'home' ? 'page' : undefined}
            >
              {t('nav.home')}
            </a>
          </li>
          <li>
            <a
              href="#/projects"
              onClick={closeNav}
              aria-current={page.name === 'projects' ? 'page' : undefined}
            >
              {t('nav.projects')}
            </a>
          </li>
          <li>
            <a
              href="#/resources"
              onClick={closeNav}
              aria-current={page.name === 'resources' ? 'page' : undefined}
            >
              {t('nav.resources')}
            </a>
          </li>
          <li>
            <a
              href="#/activity"
              onClick={closeNav}
              aria-current={page.name === 'activity' ? 'page' : undefined}
            >
              {t('nav.activity')}
            </a>
          </li>
          <li>
            <a
              href="#/connections"
              onClick={closeNav}
              aria-current={page.name === 'connections' ? 'page' : undefined}
            >
              {t('nav.connections')}
            </a>
          </li>
        </ul>
      </nav>
      <div className="header-actions">
        <ConnectionsBadge state={connections} />
        <ActivityBadge state={runs} missions={missions} />
        <label className="language" title={t('language.label')}>
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
          </svg>
          <select
            value={language}
            aria-label={t('language.label')}
            onChange={(e) => setLanguage(e.target.value as Language)}
          >
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {l.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <UserMenu email={email} onLogout={onLogout} />
      </div>
      <button
        type="button"
        className="icon nav-toggle"
        aria-label={t(navOpen ? 'nav.close' : 'nav.open')}
        aria-expanded={navOpen}
        aria-controls="app-nav"
        onClick={() => setNavOpen((open) => !open)}
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          aria-hidden="true"
        >
          {navOpen ? (
            <path d="M6 6l12 12M18 6 6 18" />
          ) : (
            <path d="M4 7h16M4 12h16M4 17h16" />
          )}
        </svg>
      </button>
    </header>
  )
}

function App() {
  const { user, loading, logout } = useAuth()
  const page = usePage()
  const connections = useConnections(Boolean(user))
  const runs = useActiveRuns(Boolean(user))
  const missions = useMissionNotifications(Boolean(user))
  const { t } = useI18n()

  /* The visible height: on phones it excludes the keyboard, so the composer
     stays above it instead of hiding behind it. */
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const root = document.documentElement
    const update = () =>
      root.style.setProperty('--app-height', `${Math.round(viewport.height)}px`)
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
      root.style.removeProperty('--app-height')
    }
  }, [])

  if (loading) return <main className="auth">{t('app.loading')}</main>
  if (!user) return <LoginPage />

  return (
    <div className={page.name === 'workspace' ? 'layout fill' : 'layout'}>
      <AppHeader
        page={page}
        connections={connections}
        runs={runs}
        missions={missions.unread}
        email={user.email}
        onLogout={logout}
      />
      <main className="home">
        {page.name === 'projects' && <ProjectsPage />}
        {page.name === 'resources' && <LibraryPage />}
        {page.name === 'connections' && <ConnectionsPage state={connections} />}
        {page.name === 'activity' && (
          <ActivityPage state={runs} missions={missions.unread} notify={missions.request} />
        )}
        {page.name === 'profile' && <ProfilePage />}
        {page.name === 'workspace' && (
          <ProjectWorkspace
            key={page.projectId}
            projectId={page.projectId}
            runId={page.runId}
            missionId={page.missionId}
            connections={connections}
            runs={runs}
          />
        )}
        {page.name === 'home' && <Dashboard connections={connections} />}
      </main>
    </div>
  )
}

function Dashboard({ connections }: { connections: ConnectionsState }) {
  const { t } = useI18n()

  return (
    <>
      {/* Until a provider is connected, point to where that happens. */}
      {!connections.checking && connections.connected.length === 0 && (
        <p className="hint">
          {t('connections.homePrompt')} <a href="#/connections">{t('nav.connections')}</a>
        </p>
      )}
      <ProjectCards />
    </>
  )
}

export default App
