import { useEffect, useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import { projectsApi, type Project } from './api'

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
              <a className="card project-card" href={`#/workspace/${p.id}`}>
                <strong>{p.name}</strong>
                <code>{p.path}</code>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
