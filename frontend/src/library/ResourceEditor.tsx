import { useState, type FormEvent } from 'react'
import { FILE_ACCESS_LABEL } from '../agents/labels'
import {
  libraryApi,
  type AgentSpec,
  type EditableKind,
  type FileAccess,
  type Library,
  type McpSpec,
  type SkillSpec,
  type SpecByKind,
  type WorkflowSpec,
} from './api'

const KIND_LABEL: Record<EditableKind, string> = {
  agent: 'Agente',
  mcp: 'Server MCP',
  skill: 'Skill',
  workflow: 'Workflow',
}

const DEFAULTS: SpecByKind = {
  agent: {
    description: '',
    enabledByDefault: true,
    permissions: { files: 'read', tools: [], mcp: [], skills: [] },
    prompt: '',
  },
  mcp: { description: '', enabledByDefault: false, type: 'http', url: '', headers: {} },
  skill: { description: '', enabledByDefault: true, content: '' },
  workflow: {
    description: '',
    enabledByDefault: true,
    input: 'Input',
    steps: [{ agent: '', prompt: '{{input}}' }],
  },
}

const LIST: Record<EditableKind, 'agents' | 'mcp' | 'skills' | 'workflows'> = {
  agent: 'agents',
  mcp: 'mcp',
  skill: 'skills',
  workflow: 'workflows',
}

/** The stored spec of `key`, without its key, or the defaults for a new one. */
function initialSpec<K extends EditableKind>(kind: K, key: string | null, library: Library) {
  const item = key ? library[LIST[kind]].find((r) => r.key === key) : undefined
  if (!item) return structuredClone(DEFAULTS[kind])
  const { key: _key, ...spec } = item
  return spec as unknown as SpecByKind[K]
}

/** `KEY=value` lines, the editable form of env and headers. */
const toLines = (map: Record<string, string>) =>
  Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')

function fromLines(text: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) map[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return map
}

interface Props {
  kind: EditableKind
  /** Key of the resource to edit; null creates a new one. */
  editing: string | null
  library: Library
  onDone: (saved: boolean) => void
}

/** Form for one library resource; validation errors come from the server. */
export function ResourceEditor({ kind, editing, library, onDone }: Props) {
  const [key, setKey] = useState(editing ?? '')
  const [spec, setSpec] = useState(() => initialSpec(kind, editing, library))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const patch = (change: Partial<SpecByKind[typeof kind]>) =>
    setSpec((s) => ({ ...s, ...change }) as SpecByKind[typeof kind])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await (editing
        ? libraryApi.update(kind, editing, spec)
        : libraryApi.create(kind, key.trim(), spec))
      onDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Salvataggio non riuscito')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="card editor stack" onSubmit={submit}>
      <h2>
        {editing ? 'Modifica' : 'Nuovo'}: {KIND_LABEL[kind]}
      </h2>
      <label>
        Nome
        <input
          value={key}
          disabled={editing !== null}
          required
          pattern="[a-z0-9][a-z0-9\-]{0,63}"
          title="Minuscole, cifre e trattini"
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      <label>
        Descrizione
        <input
          value={spec.description}
          required
          onChange={(e) => patch({ description: e.target.value })}
        />
      </label>
      <label className="switch">
        <input
          type="checkbox"
          checked={spec.enabledByDefault}
          onChange={(e) => patch({ enabledByDefault: e.target.checked })}
        />
        Attivo di default nei progetti
      </label>

      {kind === 'agent' && (
        <AgentFields
          spec={spec as AgentSpec}
          library={library}
          onChange={(s) => setSpec(s as SpecByKind[typeof kind])}
        />
      )}
      {kind === 'mcp' && (
        <McpFields
          spec={spec as McpSpec}
          editing={editing !== null}
          stdioAllowed={library.stdioAllowed}
          onChange={(s) => setSpec(s as SpecByKind[typeof kind])}
        />
      )}
      {kind === 'skill' && (
        <label>
          Istruzioni (Markdown)
          <textarea
            rows={14}
            required
            value={(spec as SkillSpec).content}
            onChange={(e) => patch({ content: e.target.value } as Partial<SkillSpec>)}
          />
        </label>
      )}
      {kind === 'workflow' && (
        <WorkflowFields
          spec={spec as WorkflowSpec}
          library={library}
          onChange={(s) => setSpec(s as SpecByKind[typeof kind])}
        />
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row end">
        <button type="button" className="secondary" onClick={() => onDone(false)}>
          Annulla
        </button>
        <button type="submit" disabled={saving}>
          Salva
        </button>
      </div>
    </form>
  )
}

function Checklist({
  legend,
  options,
  selected,
  onChange,
}: {
  legend: string
  options: { key: string; description: string }[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  return (
    <fieldset className="checklist">
      <legend>{legend}</legend>
      {options.length === 0 && <p className="hint">Nessuno nella libreria.</p>}
      {options.map((o) => (
        <label key={o.key} className="switch" title={o.description}>
          <input
            type="checkbox"
            checked={selected.includes(o.key)}
            onChange={(e) =>
              onChange(
                e.target.checked ? [...selected, o.key] : selected.filter((k) => k !== o.key),
              )
            }
          />
          {o.key}
        </label>
      ))}
    </fieldset>
  )
}

function AgentFields({
  spec,
  library,
  onChange,
}: {
  spec: AgentSpec
  library: Library
  onChange: (spec: AgentSpec) => void
}) {
  const permissions = (change: Partial<AgentSpec['permissions']>) =>
    onChange({ ...spec, permissions: { ...spec.permissions, ...change } })
  return (
    <>
      <div className="row">
        <label className="grow">
          Modello (vuoto = quello della chat)
          <input
            value={spec.model ?? ''}
            placeholder="es. sonnet, opus, haiku"
            onChange={(e) => onChange({ ...spec, model: e.target.value || undefined })}
          />
        </label>
        <label>
          Max turni
          <input
            type="number"
            min={1}
            max={100}
            value={spec.maxTurns ?? ''}
            onChange={(e) =>
              onChange({ ...spec, maxTurns: e.target.value ? Number(e.target.value) : undefined })
            }
          />
        </label>
      </div>
      <fieldset className="checklist">
        <legend>Permessi</legend>
        <label>
          File del progetto
          <select
            value={spec.permissions.files}
            onChange={(e) => permissions({ files: e.target.value as FileAccess })}
          >
            {(['none', 'read', 'write'] as const).map((f) => (
              <option key={f} value={f}>
                {FILE_ACCESS_LABEL[f]}
              </option>
            ))}
          </select>
        </label>
        <Checklist
          legend="Tool"
          options={library.tools}
          selected={spec.permissions.tools}
          onChange={(tools) => permissions({ tools })}
        />
        <Checklist
          legend="Server MCP"
          options={library.mcp}
          selected={spec.permissions.mcp}
          onChange={(mcp) => permissions({ mcp })}
        />
        <Checklist
          legend="Skill"
          options={library.skills}
          selected={spec.permissions.skills}
          onChange={(skills) => permissions({ skills })}
        />
      </fieldset>
      <label>
        Prompt di sistema
        <textarea
          rows={10}
          required
          value={spec.prompt}
          onChange={(e) => onChange({ ...spec, prompt: e.target.value })}
        />
      </label>
    </>
  )
}

function McpFields({
  spec,
  editing,
  stdioAllowed,
  onChange,
}: {
  spec: McpSpec
  editing: boolean
  stdioAllowed: boolean
  onChange: (spec: McpSpec) => void
}) {
  const { description, enabledByDefault } = spec
  const secrets = spec.type === 'stdio' ? spec.env : spec.headers
  const [secretText, setSecretText] = useState(toLines(secrets))
  const setSecrets = (text: string) => {
    setSecretText(text)
    onChange(
      spec.type === 'stdio'
        ? { ...spec, env: fromLines(text) }
        : { ...spec, headers: fromLines(text) },
    )
  }
  return (
    <>
      <label>
        Tipo
        <select
          value={spec.type}
          onChange={(e) => {
            setSecretText('')
            onChange(
              e.target.value === 'stdio'
                ? { description, enabledByDefault, type: 'stdio', command: '', args: [], env: {} }
                : { description, enabledByDefault, type: 'http', url: '', headers: {} },
            )
          }}
        >
          <option value="http">http (URL remoto)</option>
          <option value="stdio" disabled={!stdioAllowed}>
            stdio (comando locale){stdioAllowed ? '' : ' — solo in modalità personale'}
          </option>
        </select>
      </label>
      {spec.type === 'http' ? (
        <label>
          URL
          <input
            type="url"
            required
            value={spec.url}
            onChange={(e) => onChange({ ...spec, url: e.target.value })}
          />
        </label>
      ) : (
        <>
          <p className="error">
            Un server stdio esegue questo comando sul server con i privilegi del backend.
          </p>
          <label>
            Comando
            <input
              required
              value={spec.command}
              onChange={(e) => onChange({ ...spec, command: e.target.value })}
            />
          </label>
          <label>
            Argomenti (uno per riga)
            <textarea
              rows={3}
              value={spec.args.join('\n')}
              onChange={(e) =>
                onChange({ ...spec, args: e.target.value.split('\n').filter((a) => a !== '') })
              }
            />
          </label>
        </>
      )}
      <label>
        {spec.type === 'stdio' ? 'Variabili d’ambiente' : 'Header'} (una per riga, NOME=valore)
        <textarea
          rows={3}
          value={secretText}
          placeholder={spec.type === 'stdio' ? 'API_KEY=…' : 'Authorization=Bearer …'}
          onChange={(e) => setSecrets(e.target.value)}
        />
      </label>
      <p className="hint">
        I valori sono cifrati e non vengono mai rimostrati.
        {editing && ' Un valore lasciato vuoto mantiene quello salvato.'} Puoi usare{' '}
        <code>{'${VARIABILE}'}</code> per leggere dall’ambiente del backend.
      </p>
    </>
  )
}

function WorkflowFields({
  spec,
  library,
  onChange,
}: {
  spec: WorkflowSpec
  library: Library
  onChange: (spec: WorkflowSpec) => void
}) {
  const setStep = (index: number, change: Partial<WorkflowSpec['steps'][number]>) =>
    onChange({
      ...spec,
      steps: spec.steps.map((s, i) => (i === index ? { ...s, ...change } : s)),
    })
  return (
    <>
      <label>
        Etichetta dell’input
        <input value={spec.input} onChange={(e) => onChange({ ...spec, input: e.target.value })} />
      </label>
      <fieldset className="checklist">
        <legend>Passi, eseguiti in ordine</legend>
        <p className="hint">
          Nel prompt: <code>{'{{input}}'}</code> è il testo dell’utente,{' '}
          <code>{'{{previous}}'}</code> la risposta del passo precedente.
        </p>
        <ol className="run-steps">
          {spec.steps.map((step, i) => (
            <li key={i}>
              <div className="row">
                <select
                  aria-label="Agente"
                  required
                  value={step.agent}
                  onChange={(e) => setStep(i, { agent: e.target.value })}
                >
                  <option value="">Scegli un agente…</option>
                  {library.agents.map((a) => (
                    <option key={a.key} value={a.key}>
                      {a.key}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="link danger"
                  disabled={spec.steps.length === 1}
                  onClick={() => onChange({ ...spec, steps: spec.steps.filter((_, j) => j !== i) })}
                >
                  Rimuovi
                </button>
              </div>
              <textarea
                aria-label="Prompt"
                rows={4}
                required
                value={step.prompt}
                onChange={(e) => setStep(i, { prompt: e.target.value })}
              />
            </li>
          ))}
        </ol>
        <div>
          <button
            type="button"
            className="secondary"
            disabled={spec.steps.length >= 10}
            onClick={() =>
              onChange({ ...spec, steps: [...spec.steps, { agent: '', prompt: '{{previous}}' }] })
            }
          >
            Aggiungi passo
          </button>
        </div>
      </fieldset>
    </>
  )
}
