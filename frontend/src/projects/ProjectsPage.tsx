import { useEffect, useRef, useState, type FormEvent } from 'react'
import { EditIcon, TrashIcon } from '../components/Icons'
import { useI18n } from '../i18n/useI18n'
import { missionsApi, type Mission } from '../missions/api'
import { projectsApi, type Project } from './api'
import { NewProjectDialog } from './NewProjectDialog'
import { PathPicker } from './PathPicker'
import { DEFAULT_PROJECT_COLOR, ProjectIcon } from './ProjectIcon'

type Editing = {
  id: number | null
  name: string
  path: string
  /** '' means the default gradient. */
  color: string
  logo: string | null
}

const MAX_LOGO_BYTES = 2 * 1024 * 1024

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
  const logoRef = useRef<HTMLInputElement>(null)

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
        ? {
            id: project.id,
            name: project.name,
            path: project.path,
            color: project.color ?? '',
            logo: project.logo,
          }
        : { id: null, name: '', path: '', color: '', logo: null },
    )
  }

  /** Reads the chosen image as a data URL: the backend stores it with the project. */
  function chooseLogo(file: File | undefined) {
    if (!editing || !file) return
    if (!file.type.startsWith('image/')) {
      setFormError(t('projects.logoNotImage'))
      return
    }
    if (file.size > MAX_LOGO_BYTES) {
      setFormError(t('projects.logoTooBig'))
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      setFormError(null)
      setEditing((current) => current && { ...current, logo: String(reader.result) })
    }
    reader.onerror = () => setFormError(t('projects.logoError'))
    reader.readAsDataURL(file)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!editing) return
    setSaving(true)
    setFormError(null)
    try {
      const body = {
        name: editing.name,
        path: editing.path,
        color: editing.color || null,
        logo: editing.logo,
      }
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
          <div className="project-appearance">
            <div className="project-field">
              <span>{t('projects.color')}</span>
              <div className="row color-choice">
                <input
                  type="color"
                  value={editing.color || DEFAULT_PROJECT_COLOR}
                  aria-label={t('projects.color')}
                  onChange={(e) => setEditing({ ...editing, color: e.target.value })}
                />
                <button
                  type="button"
                  className="link"
                  disabled={!editing.color}
                  onClick={() => setEditing({ ...editing, color: '' })}
                >
                  {t('projects.colorDefault')}
                </button>
              </div>
            </div>
            <div className="project-field">
              <span>{t('projects.logo')}</span>
              <div className="row logo-choice">
                <ProjectIcon
                  name={editing.name}
                  color={editing.color}
                  logo={editing.logo}
                  className="project-icon-sm"
                />
                <button
                  type="button"
                  className="secondary"
                  onClick={() => logoRef.current?.click()}
                >
                  {t('projects.chooseLogo')}
                </button>
                {editing.logo && (
                  <button
                    type="button"
                    className="link danger"
                    onClick={() => setEditing({ ...editing, logo: null })}
                  >
                    {t('projects.removeLogo')}
                  </button>
                )}
              </div>
              <input
                ref={logoRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  chooseLogo(e.target.files?.[0])
                  // Allows choosing the same file again after removing it.
                  e.target.value = ''
                }}
              />
              <small className="hint">{t('projects.logoHint')}</small>
            </div>
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
                <td>
                  <span className="project-name">
                    <ProjectIcon
                      name={p.name}
                      color={p.color}
                      logo={p.logo}
                      className="project-icon-sm"
                    />
                    {p.name}
                  </span>
                </td>
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
                      <button
                        type="button"
                        className="danger icon-action"
                        aria-label={t('projects.delete')}
                        title={t('projects.delete')}
                        onClick={() => void remove(p)}
                      >
                        <TrashIcon />
                      </button>
                    </>
                  ) : (
                    <span className="row-actions">
                      <button
                        type="button"
                        className="link icon-action"
                        aria-label={t('projects.edit')}
                        title={t('projects.edit')}
                        onClick={() => startEdit(p)}
                      >
                        <EditIcon />
                      </button>
                      <button
                        type="button"
                        className="link danger icon-action"
                        aria-label={t('projects.delete')}
                        title={t('projects.delete')}
                        onClick={() => setDeleting(p)}
                      >
                        <TrashIcon />
                      </button>
                    </span>
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
