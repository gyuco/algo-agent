import { useEffect, useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import { projectsApi, type Project } from './api'

/** Last two folders of a path, with an ellipsis when something is hidden. */
function shortPath(path: string) {
  const parts = path.split('/').filter(Boolean)
  if (parts.length <= 2) return path
  return `…/${parts.slice(-2).join('/')}`
}

/** Dashboard grid: one card per project, each opening its workspace. */
export function ProjectCards() {
  const { t } = useI18n()
  const [projects, setProjects] = useState<Project[] | null>(null)
  /** '' means a failure without a server message. */
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    projectsApi.list().then(setProjects, (err: unknown) =>
      setError(err instanceof Error ? err.message : ''),
    )
  }, [])

  return (
    <section className="project-cards" aria-labelledby="project-cards-title">
      <h2 id="project-cards-title">{t('nav.projects')}</h2>
      {error !== null && (
        <p className="error" role="alert">
          {error || t('projects.loadError')}
        </p>
      )}
      {projects === null && error === null && <p className="hint">{t('projects.loading')}</p>}
      {projects?.length === 0 && (
        <p className="hint">
          {t('projects.empty')} <a href="#/projects">{t('projects.new')}</a>
        </p>
      )}
      {projects && projects.length > 0 && (
        <ul className="cards">
          {projects.map((p) => (
            <li key={p.id}>
              <a className="card project-card" href={`#/workspace/${p.id}`} title={p.path}>
                <span className="project-icon" aria-hidden="true">
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="project-body">
                  <strong>{p.name}</strong>
                  <code title={p.path}>{shortPath(p.path)}</code>
                </span>
                <span className="project-open" aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
