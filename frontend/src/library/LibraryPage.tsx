import { useCallback, useEffect, useState } from 'react'
import { FILE_ACCESS_LABEL } from '../agents/labels'
import { libraryApi, type EditableKind, type Library } from './api'
import { ResourceEditor } from './ResourceEditor'

interface Row {
  key: string
  description: string
  /** Short facts shown next to the description. */
  details: string[]
}

/** The user's resource library: agents, MCP servers, skills and workflows usable in every project. */
export function LibraryPage() {
  const [library, setLibrary] = useState<Library | null>(null)
  const [editing, setEditing] = useState<{ kind: EditableKind; key: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(() => {
    libraryApi.get().then(setLibrary, (err: unknown) =>
      setError(err instanceof Error ? err.message : 'Impossibile caricare la libreria'),
    )
  }, [])

  useEffect(load, [load])

  async function remove(kind: EditableKind, key: string) {
    setDeleting(null)
    setError(null)
    try {
      await libraryApi.remove(kind, key)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Eliminazione non riuscita')
    }
  }

  async function importExamples() {
    setError(null)
    try {
      const { imported } = await libraryApi.importExamples()
      setNotice(imported.length ? `Importati: ${imported.join(', ')}` : 'Nessun esempio nuovo da importare')
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Importazione non riuscita')
    }
  }

  if (!library) {
    return error ? (
      <p className="error" role="alert">
        {error}
      </p>
    ) : (
      <p className="hint">Caricamento…</p>
    )
  }

  if (editing) {
    return (
      <ResourceEditor
        key={`${editing.kind}:${editing.key}`}
        kind={editing.kind}
        editing={editing.key}
        library={library}
        onDone={(saved) => {
          setEditing(null)
          if (saved) load()
        }}
      />
    )
  }

  const sections: [EditableKind, string, Row[]][] = [
    [
      'agent',
      'Agenti',
      library.agents.map((a) => ({
        key: a.key,
        description: a.description,
        details: [
          `file: ${FILE_ACCESS_LABEL[a.permissions.files]}`,
          ...a.permissions.tools.map((k) => `tool: ${k}`),
          ...a.permissions.mcp.map((k) => `MCP: ${k}`),
          ...a.permissions.skills.map((k) => `skill: ${k}`),
          ...(a.model ? [`modello: ${a.model}`] : []),
        ],
      })),
    ],
    [
      'workflow',
      'Workflow',
      library.workflows.map((w) => ({
        key: w.key,
        description: w.description,
        details: [w.steps.map((s) => s.agent).join(' → ')],
      })),
    ],
    [
      'mcp',
      'Server MCP',
      library.mcp.map((m) => ({
        key: m.key,
        description: m.description,
        details: [m.type === 'http' ? m.url : `${m.command} ${m.args.join(' ')}`],
      })),
    ],
    [
      'skill',
      'Skill',
      library.skills.map((s) => ({ key: s.key, description: s.description, details: [] })),
    ],
  ]

  return (
    <div className="library">
      <div className="row workspace-head">
        <h1 className="grow">Risorse</h1>
        <button type="button" className="secondary" onClick={() => void importExamples()}>
          Importa esempi
        </button>
      </div>
      <p className="hint">
        La tua libreria, usabile in tutti i progetti. In ogni progetto scegli cosa attivare dalla
        scheda «Agenti e risorse».
      </p>
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
              Nuovo
            </button>
          </div>
          {rows.length === 0 ? (
            <p className="hint">Nessuno.</p>
          ) : (
            <ul className="resource-list">
              {rows.map((r) => (
                <li key={r.key}>
                  <div className="row">
                    <strong className="grow">{r.key}</strong>
                    {deleting === `${kind}:${r.key}` ? (
                      <>
                        <span className="hint">Eliminare "{r.key}"?</span>
                        <button type="button" className="secondary" onClick={() => setDeleting(null)}>
                          Annulla
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => void remove(kind, r.key)}
                        >
                          Elimina
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="link"
                          onClick={() => setEditing({ kind, key: r.key })}
                        >
                          Modifica
                        </button>
                        <button
                          type="button"
                          className="link danger"
                          onClick={() => setDeleting(`${kind}:${r.key}`)}
                        >
                          Elimina
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

      <section className="card resources">
        <h2>Tool</h2>
        <p className="hint">Scritti in codice (backend/src/catalog/app-tools.ts), non modificabili da qui.</p>
        <ul className="resource-list">
          {library.tools.map((t) => (
            <li key={t.key}>
              <strong>{t.key}</strong>
              <span className="hint">{t.description}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
