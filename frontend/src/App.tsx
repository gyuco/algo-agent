import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { LoginPage } from './auth/LoginPage'
import { ProfilePage } from './auth/ProfilePage'
import { UserMenu } from './auth/UserMenu'
import { useAuth } from './auth/useAuth'
import { LANGUAGES, type MessageKey } from './i18n/messages'
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

/** Line icon wrapper for the navigation entries. */
function NavIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** Every page, in the order the hamburger menu shows them. */
const NAV_ITEMS: {
  href: string
  label: MessageKey
  match: Page['name']
  icon: ReactNode
}[] = [
  {
    href: '#/',
    label: 'nav.home',
    match: 'home',
    icon: (
      <NavIcon>
        <path d="M4 11.5 12 4l8 7.5" />
        <path d="M6 10v9h12v-9" />
      </NavIcon>
    ),
  },
  {
    href: '#/projects',
    label: 'nav.projects',
    match: 'projects',
    icon: (
      <NavIcon>
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      </NavIcon>
    ),
  },
  {
    href: '#/resources',
    label: 'nav.resources',
    match: 'resources',
    icon: (
      <NavIcon>
        <path d="m12 3 8 4.5-8 4.5-8-4.5Z" />
        <path d="m4 12 8 4.5 8-4.5" />
        <path d="m4 16.5 8 4.5 8-4.5" />
      </NavIcon>
    ),
  },
  {
    href: '#/activity',
    label: 'nav.activity',
    match: 'activity',
    icon: (
      <NavIcon>
        <path d="M3 12h4l2.5-7 5 14 2.5-7h4" />
      </NavIcon>
    ),
  },
  {
    href: '#/connections',
    label: 'nav.connections',
    match: 'connections',
    icon: (
      <NavIcon>
        <path d="M9 15 15 9" />
        <path d="M7.5 10.5 5 13a3.5 3.5 0 0 0 5 5l2.5-2.5" />
        <path d="M16.5 13.5 19 11a3.5 3.5 0 0 0-5-5l-2.5 2.5" />
      </NavIcon>
    ),
  },
]

/** What the top bar shows beside the hamburger on wide screens. */
const PAGE_TITLES: Partial<Record<Page['name'], MessageKey>> = {
  home: 'nav.home',
  projects: 'nav.projects',
  resources: 'nav.resources',
  activity: 'nav.activity',
  connections: 'nav.connections',
  profile: 'user.profile',
}

/** The navigation, as a drawer instead of a header bar. */
function NavDrawer({
  page,
  connections,
  runs,
  missions,
  email,
  onClose,
}: {
  page: Page
  connections: ConnectionsState
  runs: ActiveRunsState
  missions: number
  email: string
  onClose: () => void
}) {
  const { t, language, setLanguage } = useI18n()
  const panel = useRef<HTMLDivElement>(null)
  const needYou = runs.attention.length + missions

  // Escape closes it, Tab stays inside, and the page behind doesn't scroll.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.querySelector<HTMLElement>('a[href], button:not([disabled])')?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panel.current) return
      const items = panel.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled])',
      )
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = overflow
      previous?.focus()
    }
  }, [onClose])

  return (
    <div className="nav-drawer">
      <div className="nav-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        id="app-nav"
        className="nav-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('nav.label')}
        ref={panel}
      >
        <div className="nav-head">
          <a className="brand" href="#/" onClick={onClose}>
            <span className="brand-mark" aria-hidden="true">
              a
            </span>
            algo-agent
          </a>
          <button
            type="button"
            className="icon nav-close"
            aria-label={t('nav.close')}
            onClick={onClose}
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <nav aria-label={t('nav.label')}>
          <ul>
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  onClick={onClose}
                  aria-current={page.name === item.match ? 'page' : undefined}
                >
                  {item.icon}
                  <span>{t(item.label)}</span>
                  {item.match === 'activity' && needYou > 0 && (
                    <span className="nav-count">{needYou}</span>
                  )}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="nav-foot">
          <ConnectionsBadge state={connections} />
          <ActivityBadge state={runs} missions={missions} />
          <div className="nav-language">
            <span>{t('language.label')}</span>
            <div className="lang-options" role="group" aria-label={t('language.label')}>
              {LANGUAGES.map((l) => (
                <button
                  key={l}
                  type="button"
                  aria-pressed={language === l}
                  onClick={() => setLanguage(l)}
                >
                  {l.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <p className="nav-account" title={email}>
            {email}
          </p>
        </div>
      </div>
    </div>
  )
}

/** Top bar: only the hamburger on the left and the account on the right. */
function AppTopBar({
  page,
  contextTitle,
  connections,
  runs,
  missions,
  email,
  onLogout,
}: {
  page: Page
  contextTitle: string | null
  connections: ConnectionsState
  runs: ActiveRunsState
  missions: number
  email: string
  onLogout: () => void
}) {
  const { t } = useI18n()
  const [navOpen, setNavOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const closeNav = useCallback(() => setNavOpen(false), [])
  const closeAndFocus = useCallback(() => {
    setNavOpen(false)
    trigger.current?.focus()
  }, [])

  // Back/forward closes the drawer: the new page is already showing.
  useEffect(() => {
    window.addEventListener('hashchange', closeNav)
    return () => window.removeEventListener('hashchange', closeNav)
  }, [closeNav])

  const needYou = runs.attention.length + missions

  return (
    <>
      <header className="app-topbar">
        <div className="topbar-start">
          <button
            ref={trigger}
            type="button"
            className="topbar-toggle"
            aria-label={t(navOpen ? 'nav.close' : 'nav.open')}
            aria-expanded={navOpen}
            aria-controls="app-nav"
            onClick={() => setNavOpen((open) => !open)}
          >
            <svg
              viewBox="0 0 24 24"
              width="22"
              height="22"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
            {(needYou > 0 || runs.active.length > 0) && (
              <span
                className={`topbar-alert${needYou > 0 ? ' attention' : ''}`}
                aria-hidden="true"
              />
            )}
          </button>
          {contextTitle && <span className="topbar-context">{contextTitle}</span>}
        </div>
        <UserMenu email={email} onLogout={onLogout} />
      </header>
      {navOpen && (
        <NavDrawer
          page={page}
          connections={connections}
          runs={runs}
          missions={missions}
          email={email}
          onClose={closeAndFocus}
        />
      )}
    </>
  )
}

function App() {
  const { user, loading, logout } = useAuth()
  const page = usePage()
  const connections = useConnections(Boolean(user))
  const runs = useActiveRuns(Boolean(user))
  const missions = useMissionNotifications(Boolean(user))
  const { t } = useI18n()
  /** The open project, so the top bar can name it without a header in the chat. */
  const [workspaceTitle, setWorkspaceTitle] = useState<{ projectId: number; name: string } | null>(
    null,
  )
  const rememberProjectName = useCallback((projectId: number, name: string) => {
    setWorkspaceTitle({ projectId, name })
  }, [])

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

  const displayName = user.name?.trim() || user.email.split('@')[0]
  const pageTitle = PAGE_TITLES[page.name]
  const contextTitle =
    page.name === 'workspace'
      ? workspaceTitle?.projectId === page.projectId
        ? workspaceTitle.name
        : null
      : pageTitle
        ? t(pageTitle)
        : null

  return (
    <div className={page.name === 'workspace' ? 'layout fill' : 'layout'}>
      <AppTopBar
        page={page}
        contextTitle={contextTitle}
        connections={connections}
        runs={runs}
        missions={missions.unread}
        email={user.email}
        onLogout={logout}
      />
      <main className={page.name === 'home' ? 'home home-dashboard' : 'home'}>
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
            onProjectName={rememberProjectName}
          />
        )}
        {page.name === 'home' && <Dashboard connections={connections} name={displayName} />}
      </main>
    </div>
  )
}

/** The sunburst over the greeting. */
function HeroMark() {
  return (
    <span className="hero-mark" aria-hidden="true">
      <svg
        viewBox="0 0 64 64"
        width="56"
        height="56"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      >
        {Array.from({ length: 12 }, (_, i) => (
          <line key={i} x1="32" y1="6" x2="32" y2="21" transform={`rotate(${i * 30} 32 32)`} />
        ))}
      </svg>
    </span>
  )
}

/** Hour the app was opened: the greeting stays put while it is on screen. */
const OPENED_HOUR = new Date().getHours()

function Dashboard({ connections, name }: { connections: ConnectionsState; name: string }) {
  const { t } = useI18n()
  const greeting = t(
    OPENED_HOUR < 12
      ? 'greeting.morning'
      : OPENED_HOUR < 18
        ? 'greeting.afternoon'
        : 'greeting.evening',
  )

  return (
    <div className="dashboard">
      <section className="dashboard-hero">
        <HeroMark />
        <h1 className="hero-greeting">
          {greeting}, {name}
        </h1>
        <p className="hero-lead">{t('home.lead')}</p>
        {/* Until a provider is connected, point to where that happens. */}
        {!connections.checking && connections.connected.length === 0 && (
          <p className="home-note">
            {t('connections.homePrompt')} <a href="#/connections">{t('nav.connections')}</a>
          </p>
        )}
      </section>
      <ProjectCards />
    </div>
  )
}

export default App
