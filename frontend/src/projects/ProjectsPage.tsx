import { useEffect, useState, type FormEvent } from 'react'
import { useI18n } from '../i18n/useI18n'
import { missionsApi, type Mission } from '../missions/api'
import { projectsApi, type Project } from './api'
import { NewProjectDialog } from './NewProjectDialog'
import { PathPicker } from './PathPicker'

type Editing = { id: number | null; name: string; path: string }

export function ProjectsPage() {
  const { t } = useI18n()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  const [deleting, setDeleting] = useState<Project | null>(null)
  const [creatingMission, setCreatingMission] = useState(false)
  const [preparing, setPreparing] = useState<Mission[]>([])

  useEffect(() => {
    projectsApi.list().then(setProjects, (err: unknown) =>
      setError(err instanceof Error ? err.message : t('projects.loadError')),
    )
    void missionsApi
      .list()
      .then((list) => setPreparing(list.filter((mission) => mission.projectId === null)))
      .catch(() => undefined)
  }, [t])

  function startEdit(project?: Project) {
    setFormError(null)
    setDeleting(null)
    setEditing(
      project
        ? { id: project.id, name: project.name, path: project.path }
        : { id: null, name: '', path: '' },
    )
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!editing) return
    setSaving(true)
    setFormError(null)
    try {
      const body = { name: editing.name, path: editing.path }
      const saved =
        editing.id === null
          ? await projectsApi.create(body)
          : await projectsApi.update(editing.id, body)
      setProjects((list) =>
        [...(list ?? []).filter((p) => p.id !== saved.id), saved].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      )
      setEditing(null)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('projects.saveError'))
    } finally {
      setSaving(false)
    }
  }

  async function remove(project: Project) {
    setError(null)
    try {
      await projectsApi.remove(project.id)
      setProjects((list) => list?.filter((p) => p.id !== project.id) ?? null)
      setDeleting(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('projects.deleteError'))
    }
  }

  return (
    <section className="card projects" aria-labelledby="projects-title">
      <div className="chat-head">
        <h1 id="projects-title">{t('projects.title')}</h1>
        <div className="row">
          {!editing && (
            <button type="button" className="secondary" onClick={() => setCreatingMission(true)}>
              {t('projects.newMission')}
            </button>
          )}
          {!editing && <button onClick={() => startEdit()}>{t('projects.new')}</button>}
        </div>
      </div>

      {editing && (
        <form className="option" onSubmit={save}>
          <h2>{editing.id === null ? t('projects.new') : t('projects.editTitle')}</h2>
          <label>
            {t('projects.name')}
            <input
              required
              maxLength={120}
              autoFocus
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </label>
          <div className="row workspace">
            <label className="grow">
              {t('projects.path')}
              <input
                required
                placeholder="/Users/me/project"
                value={editing.path}
                onChange={(e) => setEditing({ ...editing, path: e.target.value })}
              />
            </label>
            <button type="button" className="secondary" onClick={() => setPicking(true)}>
              {t('projects.browse')}
            </button>
          </div>
          {formError && (
            <p className="error" role="alert">
              {formError}
            </p>
          )}
          <div className="row end">
            <button type="button" className="secondary" onClick={() => setEditing(null)}>
              {t('projects.cancel')}
            </button>
            <button type="submit" disabled={saving}>
              {editing.id === null ? t('projects.create') : t('projects.save')}
            </button>
          </div>
        </form>
      )}

      {creatingMission && (
        <NewProjectDialog
          onClose={() => setCreatingMission(false)}
          onCreated={() => {
            setCreatingMission(false)
            window.location.hash = '#/activity'
          }}
        />
      )}

      {preparing.length > 0 && (
        <section>
          <h2>{t('projects.preparing')}</h2>
          <ul className="activity-list">
            {preparing.map((mission) => (
              <li key={mission.id} className="activity-item">
                <div className="activity-main">
                  <span className="activity-title">{mission.title}</span>
                  <small>{mission.status}</small>
                </div>
                <a className="button secondary" href="#/activity">
                  {t('activity.open')}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {picking && editing && (
        <PathPicker
          initialPath={editing.path}
          onSelect={(path) =>
            setEditing((current) =>
              current && {
                ...current,
                path,
                // Default the name to the folder's name when none was typed.
                name: current.name || path.split('/').filter(Boolean).pop() || '',
              },
            )
          }
          onClose={() => setPicking(false)}
        />
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {projects === null && !error && <p className="hint">{t('projects.loading')}</p>}
      {projects?.length === 0 && !editing && <p className="hint">{t('projects.empty')}</p>}

      {projects && projects.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>{t('projects.name')}</th>
              <th>{t('projects.path')}</th>
              <th>
                <span className="sr-only">{t('projects.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>
                  <code>{p.path}</code>
                </td>
                <td className="actions">
                  {deleting?.id === p.id ? (
                    <>
                      <span className="hint">{t('projects.confirmDelete', { name: p.name })}</span>
                      <button type="button" className="secondary" onClick={() => setDeleting(null)}>
                        {t('projects.cancel')}
                      </button>
                      <button type="button" className="danger" onClick={() => void remove(p)}>
                        {t('projects.delete')}
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="link" onClick={() => startEdit(p)}>
                        {t('projects.edit')}
                      </button>
                      <button type="button" className="link danger" onClick={() => setDeleting(p)}>
                        {t('projects.delete')}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
