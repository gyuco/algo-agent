import { useState, type FormEvent } from 'react'
import { FILE_ACCESS_KEY } from '../agents/labels'
import type { MessageKey } from '../i18n/messages'
import { useI18n } from '../i18n/useI18n'
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

const KIND_KEY: Record<EditableKind, MessageKey> = {
  agent: 'kind.agent',
  mcp: 'kind.mcp',
  skill: 'kind.skill',
  workflow: 'kind.workflow',
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
  const { t } = useI18n()
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
      setError(err instanceof Error ? err.message : t('editor.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="card editor stack" onSubmit={submit}>
      <h2>{t(editing ? 'editor.editTitle' : 'editor.newTitle', { kind: t(KIND_KEY[kind]) })}</h2>
      <label>
        {t('editor.name')}
        <input
          value={key}
          disabled={editing !== null}
          required
          pattern="[a-z0-9][a-z0-9\-]{0,63}"
          title={t('editor.nameHint')}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      <label>
        {t('editor.description')}
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
        {t('editor.enabledDefault')}
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
          {t('editor.instructions')}
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
          {t('projects.cancel')}
        </button>
        <button type="submit" disabled={saving}>
          {t('projects.save')}
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
  const { t } = useI18n()
  return (
    <fieldset className="checklist">
      <legend>{legend}</legend>
      {options.length === 0 && <p className="hint">{t('resources.none')}</p>}
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
  const { t } = useI18n()
  const permissions = (change: Partial<AgentSpec['permissions']>) =>
    onChange({ ...spec, permissions: { ...spec.permissions, ...change } })
  return (
    <>
      <div className="row">
        <label className="grow">
          {t('editor.model')}
          <input
            value={spec.model ?? ''}
            placeholder={t('editor.modelPlaceholder')}
            onChange={(e) => onChange({ ...spec, model: e.target.value || undefined })}
          />
        </label>
        <label>
          {t('editor.maxTurns')}
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
        <legend>{t('editor.permissions')}</legend>
        <label>
          {t('editor.projectFiles')}
          <select
            value={spec.permissions.files}
            onChange={(e) => permissions({ files: e.target.value as FileAccess })}
          >
            {(['none', 'read', 'write'] as const).map((f) => (
              <option key={f} value={f}>
                {t(FILE_ACCESS_KEY[f])}
              </option>
            ))}
          </select>
        </label>
        <Checklist
          legend={t('kind.tools')}
          options={library.tools}
          selected={spec.permissions.tools}
          onChange={(tools) => permissions({ tools })}
        />
        <Checklist
          legend={t('kind.mcps')}
          options={library.mcp}
          selected={spec.permissions.mcp}
          onChange={(mcp) => permissions({ mcp })}
        />
        <Checklist
          legend={t('kind.skills')}
          options={library.skills}
          selected={spec.permissions.skills}
          onChange={(skills) => permissions({ skills })}
        />
      </fieldset>
      <label>
        {t('editor.systemPrompt')}
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
  const { t } = useI18n()
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
        {t('editor.type')}
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
          <option value="http">{t('editor.typeHttp')}</option>
          <option value="stdio" disabled={!stdioAllowed}>
            {t('editor.typeStdio')}
            {stdioAllowed ? '' : t('editor.stdioPersonalOnly')}
          </option>
        </select>
      </label>
      {spec.type === 'http' ? (
        <label>
          {t('editor.url')}
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
            {t('editor.stdioWarning')}
          </p>
          <label>
            {t('editor.command')}
            <input
              required
              value={spec.command}
              onChange={(e) => onChange({ ...spec, command: e.target.value })}
            />
          </label>
          <label>
            {t('editor.args')}
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
        {spec.type === 'stdio' ? t('editor.envVars') : t('editor.headers')} {t('editor.perLine')}
        <textarea
          rows={3}
          value={secretText}
          placeholder={spec.type === 'stdio' ? 'API_KEY=…' : 'Authorization=Bearer …'}
          onChange={(e) => setSecrets(e.target.value)}
        />
      </label>
      <p className="hint">
        {t('editor.secretsNote')}
        {editing && ` ${t('editor.keepSaved')}`} {t('editor.envLead')}{' '}
        <code>{'${VARIABLE}'}</code> {t('editor.envTail')}
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
  const { t } = useI18n()
  const setStep = (index: number, change: Partial<WorkflowSpec['steps'][number]>) =>
    onChange({
      ...spec,
      steps: spec.steps.map((s, i) => (i === index ? { ...s, ...change } : s)),
    })
  return (
    <>
      <label>
        {t('editor.inputLabel')}
        <input value={spec.input} onChange={(e) => onChange({ ...spec, input: e.target.value })} />
      </label>
      <fieldset className="checklist">
        <legend>{t('editor.stepsTitle')}</legend>
        <p className="hint">
          {t('editor.promptLead')} <code>{'{{input}}'}</code> {t('editor.inputMeans')}{' '}
          <code>{'{{previous}}'}</code> {t('editor.previousMeans')}
        </p>
        <ol className="run-steps">
          {spec.steps.map((step, i) => (
            <li key={i}>
              <div className="row">
                <select
                  aria-label={t('chat.agentLabel')}
                  required
                  value={step.agent}
                  onChange={(e) => setStep(i, { agent: e.target.value })}
                >
                  <option value="">{t('editor.chooseAgent')}</option>
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
                  {t('editor.remove')}
                </button>
              </div>
              <textarea
                aria-label={t('editor.prompt')}
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
            {t('editor.addStep')}
          </button>
        </div>
      </fieldset>
    </>
  )
}
