import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { FILE_ACCESS_KEY } from '../agents/labels'
import { EditIcon, TrashIcon } from '../components/Icons'
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

type Tab = EditableKind | 'tools' | 'secrets'

interface Section {
  kind: EditableKind
  title: string
  rows: Row[]
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
  const [tab, setTab] = useState<Tab>('agent')


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

  const sections: Section[] = [
    {
      kind: 'agent',
      title: t('kind.agents'),
      rows: library.agents.filter(mine('agent')).map((a) => ({
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
    },
    {
      kind: 'workflow',
      title: t('kind.workflows'),
      rows: library.workflows.filter(mine('workflow')).map((w) => ({
        key: w.key,
        description: w.description,
        details: [
          ...(w.task ? [t('missions.taskModel')] : []),
          w.steps.map((s) => s.agent).filter(Boolean).join(' → '),
        ],
      })),
    },
    {
      kind: 'mcp',
      title: t('kind.mcps'),
      rows: library.mcp.filter(mine('mcp')).map((m) => ({
        key: m.key,
        description: m.description,
        details: [m.type === 'http' ? m.url : `${m.command} ${m.args.join(' ')}`],
      })),
    },
    {
      kind: 'skill',
      title: t('kind.skills'),
      rows: library.skills
        .filter(mine('skill'))
        .map((s) => ({ key: s.key, description: s.description, details: [] })),
    },
  ]

  /** Tools and secrets only exist in the library: a project inherits them. */
  const tabs: { id: Tab; label: string; count?: number }[] = [
    ...sections.map((s) => ({ id: s.kind, label: s.title, count: s.rows.length })),
    ...(projectId === null
      ? ([
          { id: 'tools', label: t('kind.tools'), count: library.tools.length },
          { id: 'secrets', label: t('secrets.userTitle') },
        ] as const)
      : []),
  ]

  /** Arrow keys move between tabs, as expected of a tablist. */
  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const step =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    const index = tabs.findIndex((item) => item.id === tab)
    const next =
      event.key === 'Home'
        ? tabs[0]
        : event.key === 'End'
          ? tabs[tabs.length - 1]
          : step
            ? tabs[(index + step + tabs.length) % tabs.length]
            : null
    if (!next) return
    event.preventDefault()
    setTab(next.id)
    document.getElementById(`library-tab-${next.id}`)?.focus()
  }

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

      <div className="row tabs library-tabs" role="tablist" aria-label={t('library.tabs')}>
        {tabs.map(({ id, label, count }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`library-tab-${id}`}
            aria-controls={`library-panel-${id}`}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? '' : 'secondary'}
            onClick={() => setTab(id)}
            onKeyDown={onTabKeyDown}
          >
            {label}
            {count !== undefined && <span className="tab-count">{count}</span>}
          </button>
        ))}
      </div>

      {sections.map((section) => (
        <section
          key={section.kind}
          className="card resources"
          role="tabpanel"
          id={`library-panel-${section.kind}`}
          aria-labelledby={`library-tab-${section.kind}`}
          hidden={tab !== section.kind}
        >
          <div className="row">
            <h2 className="grow">{section.title}</h2>
            <button type="button" onClick={() => setEditing({ kind: section.kind, key: null })}>
              {t('library.new')}
            </button>
          </div>
          {section.rows.length === 0 ? (
            <p className="hint">{t('library.none')}</p>
          ) : (
            <ul className="resource-list">
              {section.rows.map((r) => (
                <li key={r.key}>
                  <div className="row">
                    <strong className="grow">{r.key}</strong>
                    {deleting === `${section.kind}:${r.key}` ? (
                      <>
                        <span className="hint">{t('library.confirmDelete', { name: r.key })}</span>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setDeleting(null)}
                        >
                          {t('projects.cancel')}
                        </button>
                        <button
                          type="button"
                          className="danger icon-action"
                          aria-label={t('projects.delete')}
                          title={t('projects.delete')}
                          onClick={() => void remove(section.kind, r.key)}
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
                          onClick={() => setEditing({ kind: section.kind, key: r.key })}
                        >
                          <EditIcon />
                        </button>
                        <button
                          type="button"
                          className="link danger icon-action"
                          aria-label={t('projects.delete')}
                          title={t('projects.delete')}
                          onClick={() => setDeleting(`${section.kind}:${r.key}`)}
                        >
                          <TrashIcon />
                        </button>
                      </span>
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
          <section
            className="card resources"
            role="tabpanel"
            id="library-panel-tools"
            aria-labelledby="library-tab-tools"
            hidden={tab !== 'tools'}
          >
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

          <div
            role="tabpanel"
            id="library-panel-secrets"
            aria-labelledby="library-tab-secrets"
            hidden={tab !== 'secrets'}
          >
            <SecretsPanel projectId={null} />
          </div>
        </>
      )}
    </div>
  )
}
