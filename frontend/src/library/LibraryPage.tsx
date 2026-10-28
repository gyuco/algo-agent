import { useCallback, useEffect, useMemo, useState } from 'react'
import { FILE_ACCESS_KEY } from '../agents/labels'
import { useI18n } from '../i18n/useI18n'
import { SecretsPanel } from '../vault/SecretsPanel'
import { libraryApiFor, type EditableKind, type Library } from './api'
import { ResourceEditor } from './ResourceEditor'

interface Row {
  key: string
  description: string
  /** Short facts shown next to the description. */
  details: string[]
}

interface Props {
  /** Shows this project's own resources instead of the library. */
  projectId?: number | null
  /** Called after a resource is saved or deleted. */
  onChange?: () => void
}

/**
 * The user's resource library: agents, MCP servers, skills and workflows usable
 * in every project, and their secrets. With a project: the resources of that
 * project only, inside its workspace.
 */
export function LibraryPage({ projectId = null, onChange }: Props) {
  const { t } = useI18n()
  const libraryApi = useMemo(() => libraryApiFor(projectId), [projectId])
  const [library, setLibrary] = useState<Library | null>(null)
  const [editing, setEditing] = useState<{ kind: EditableKind; key: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(() => {
    libraryApi.get().then(setLibrary, (err: unknown) =>
      setError(err instanceof Error ? err.message : t('library.loadFailed')),
    )
  }, [t, libraryApi])

  useEffect(load, [load])

  async function remove(kind: EditableKind, key: string) {
    setDeleting(null)
    setError(null)
    try {
      await libraryApi.remove(kind, key)
      load()
      onChange?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('library.deleteFailed'))
    }
  }

  async function importExamples() {
    setError(null)
    try {
      const { imported } = await libraryApi.importExamples()
      setNotice(
        imported.length
          ? t('library.imported', { list: imported.join(', ') })
          : t('library.noNewExamples'),
      )
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('library.importFailed'))
    }
  }

  if (!library) {
    return error ? (
      <p className="error" role="alert">
        {error}
      </p>
    ) : (
      <p className="hint">{t('app.loading')}</p>
    )
  }

  if (editing) {
    return (
      <ResourceEditor
        key={`${editing.kind}:${editing.key}`}
        kind={editing.kind}
        editing={editing.key}
        library={library}
        projectId={projectId}
        onDone={(saved) => {
          setEditing(null)
          if (saved) {
            load()
            onChange?.()
          }
        }}
      />
    )
  }

  /** In a project only its own resources are listed: the library has its page. */
  const mine = (kind: EditableKind) => (r: { key: string }) =>
    projectId === null || library.own.includes(`${kind}:${r.key}`)

  const sections: [EditableKind, string, Row[]][] = [
    [
      'agent',
      t('kind.agents'),
      library.agents.filter(mine('agent')).map((a) => ({
        key: a.key,
        description: a.description,
        details: [
          t('detail.files', { access: t(FILE_ACCESS_KEY[a.permissions.files]) }),
          ...a.permissions.tools.map((k) => t('detail.tool', { key: k })),
          ...a.permissions.mcp.map((k) => t('detail.mcp', { key: k })),
          ...a.permissions.skills.map((k) => t('detail.skill', { key: k })),
          ...(a.model ? [t('detail.model', { model: a.model })] : []),
        ],
      })),
    ],
    [
      'workflow',
      t('kind.workflows'),
      library.workflows.filter(mine('workflow')).map((w) => ({
        key: w.key,
        description: w.description,
        details: [w.steps.map((s) => s.agent).join(' → ')],
      })),
    ],
    [
      'mcp',
      t('kind.mcps'),
      library.mcp.filter(mine('mcp')).map((m) => ({
        key: m.key,
        description: m.description,
        details: [m.type === 'http' ? m.url : `${m.command} ${m.args.join(' ')}`],
      })),
    ],
    [
      'skill',
      t('kind.skills'),
      library.skills
        .filter(mine('skill'))
        .map((s) => ({ key: s.key, description: s.description, details: [] })),
    ],
  ]

  return (
    <div className="library">
      {projectId === null ? (
        <>
          <div className="row workspace-head">
            <h1 className="grow">{t('nav.resources')}</h1>
            <button type="button" className="secondary" onClick={() => void importExamples()}>
              {t('library.importExamples')}
            </button>
          </div>
          <p className="hint">{t('library.intro')}</p>
        </>
      ) : (
        <>
          <h2>{t('library.projectTitle')}</h2>
          <p className="hint">{t('library.projectIntro')}</p>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="hint">{notice}</p>}

      {sections.map(([kind, title, rows]) => (
        <section key={kind} className="card resources">
          <div className="row">
            <h2 className="grow">{title}</h2>
            <button type="button" onClick={() => setEditing({ kind, key: null })}>
              {t('library.new')}
            </button>
          </div>
          {rows.length === 0 ? (
            <p className="hint">{t('library.none')}</p>
          ) : (
            <ul className="resource-list">
              {rows.map((r) => (
                <li key={r.key}>
                  <div className="row">
                    <strong className="grow">{r.key}</strong>
                    {deleting === `${kind}:${r.key}` ? (
                      <>
                        <span className="hint">{t('library.confirmDelete', { name: r.key })}</span>
                        <button type="button" className="secondary" onClick={() => setDeleting(null)}>
                          {t('projects.cancel')}
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => void remove(kind, r.key)}
                        >
                          {t('projects.delete')}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="link"
                          onClick={() => setEditing({ kind, key: r.key })}
                        >
                          {t('projects.edit')}
                        </button>
                        <button
                          type="button"
                          className="link danger"
                          onClick={() => setDeleting(`${kind}:${r.key}`)}
                        >
                          {t('projects.delete')}
                        </button>
                      </>
                    )}
                  </div>
                  <span className="hint">{r.description}</span>
                  {r.details.length > 0 && (
                    <ul className="tools">
                      {r.details.map((d) => (
                        <li key={d}>{d}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      {projectId === null && (
        <>
          <section className="card resources">
            <h2>{t('kind.tools')}</h2>
            <p className="hint">{t('library.toolsNote')}</p>
            <ul className="resource-list">
              {library.tools.map((tool) => (
                <li key={tool.key}>
                  <strong>{tool.key}</strong>
                  <span className="hint">{tool.description}</span>
                </li>
              ))}
            </ul>
          </section>
          <SecretsPanel projectId={null} />
        </>
      )}
    </div>
  )
}
