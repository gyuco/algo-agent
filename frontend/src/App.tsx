import { useEffect, useState } from 'react'
import { LoginPage } from './auth/LoginPage'
import { useAuth } from './auth/useAuth'
import { LANGUAGES, type Language, type MessageKey } from './i18n/messages'
import { useI18n } from './i18n/useI18n'
import { LibraryPage } from './library/LibraryPage'
import { ProjectCards } from './projects/ProjectCards'
import { ProjectsPage } from './projects/ProjectsPage'
import { ProjectWorkspace } from './projects/ProjectWorkspace'
import { ConnectionsBadge } from './connections/ConnectionsBadge'
import { ConnectionsPage } from './connections/ConnectionsPage'
import { useConnections, type ConnectionsState } from './connections/useConnections'

function greeting(t: (key: MessageKey) => string, date = new Date()) {
  const hour = date.getHours()
  if (hour < 13) return t('greeting.morning')
  if (hour < 18) return t('greeting.afternoon')
  return t('greeting.evening')
}

type Page =
  | { name: 'home' }
  | { name: 'projects' }
  | { name: 'resources' }
  | { name: 'connections' }
  | { name: 'workspace'; projectId: number }

function pageFromHash(): Page {
  const hash = window.location.hash
  if (hash === '#/projects') return { name: 'projects' }
  if (hash === '#/resources') return { name: 'resources' }
  if (hash === '#/connections') return { name: 'connections' }
  const workspace = /^#\/workspace\/(\d+)$/.exec(hash)
  if (workspace) return { name: 'workspace', projectId: Number(workspace[1]) }
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

function Sidebar({ page }: { page: Page }) {
  const { t, language, setLanguage } = useI18n()
  return (
    <aside className="sidebar">
      <a className="brand" href="#/">
        algo-agent
      </a>
      <nav aria-label={t('nav.label')}>
        <ul>
          <li>
            <a href="#/" aria-current={page.name === 'home' ? 'page' : undefined}>
              {t('nav.home')}
            </a>
          </li>
          <li>
            <a href="#/projects" aria-current={page.name === 'projects' ? 'page' : undefined}>
              {t('nav.projects')}
            </a>
          </li>
          <li>
            <a href="#/resources" aria-current={page.name === 'resources' ? 'page' : undefined}>
              {t('nav.resources')}
            </a>
          </li>
          <li>
            <a href="#/connections" aria-current={page.name === 'connections' ? 'page' : undefined}>
              {t('nav.connections')}
            </a>
          </li>
        </ul>
      </nav>
      <label className="language">
        {t('language.label')}
        <select value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
          {LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {l.toUpperCase()}
            </option>
          ))}
        </select>
      </label>
    </aside>
  )
}

function App() {
  const { user, loading, logout } = useAuth()
  const page = usePage()
  const connections = useConnections()
  const { t } = useI18n()

  if (loading) return <main className="auth">{t('app.loading')}</main>
  if (!user) return <LoginPage />

  return (
    <div className={page.name === 'workspace' ? 'layout fill' : 'layout'}>
      <Sidebar page={page} />
      <main className="home">
        <header>
          <ConnectionsBadge state={connections} />
          <span className="user">{user.email}</span>
          <button type="button" onClick={logout}>
            {t('app.logout')}
          </button>
        </header>
        {page.name === 'projects' && <ProjectsPage />}
        {page.name === 'resources' && <LibraryPage />}
        {page.name === 'connections' && <ConnectionsPage state={connections} />}
        {page.name === 'workspace' && (
          <ProjectWorkspace key={page.projectId} projectId={page.projectId} connections={connections} />
        )}
        {page.name === 'home' && <Dashboard name={user.email.split('@')[0]} connections={connections} />}
      </main>
    </div>
  )
}

function Dashboard({ name, connections }: { name: string; connections: ConnectionsState }) {
  const { t } = useI18n()

  return (
    <>
      <h1>
        {greeting(t)}, {name}!
      </h1>
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
