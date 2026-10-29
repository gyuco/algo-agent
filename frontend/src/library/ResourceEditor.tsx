import { useState, type FormEvent } from 'react'
import { FILE_ACCESS_KEY } from '../agents/labels'
import type { MessageKey } from '../i18n/messages'
import { useI18n } from '../i18n/useI18n'
import {
  libraryApiFor,
  type AgentSpec,
  type EditableKind,
  type FileAccess,
  type Library,
  type McpSpec,
  type McpTestResult,
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

/** Numbers of the lines that aren't blank and aren't `KEY=value`: they would be dropped. */
const badLines = (text: string) =>
  text
    .split('\n')
    .flatMap((line, i) => (line.trim() && !(line.indexOf('=') > 0) ? [i + 1] : []))

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
  /** Saves into this project instead of the library. */
  projectId?: number | null
  onDone: (saved: boolean) => void
}

/** Form for one library resource; validation errors come from the server. */
export function ResourceEditor({ kind, editing, library, projectId = null, onDone }: Props) {
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
    const libraryApi = libraryApiFor(projectId)
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
      {/* A project's own resource starts on there; elsewhere it doesn't exist. */}
      {projectId === null && (
        <label className="switch">
          <input
            type="checkbox"
            checked={spec.enabledByDefault}
            onChange={(e) => patch({ enabledByDefault: e.target.checked })}
          />
          {t('editor.enabledDefault')}
        </label>
      )}

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
          editing={editing}
          projectId={projectId}
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
  projectId,
  stdioAllowed,
  onChange,
}: {
  spec: McpSpec
  /** Key of the saved server being edited, null for a new one. */
  editing: string | null
  projectId: number | null
  stdioAllowed: boolean
  onChange: (spec: McpSpec) => void
}) {
  const { t } = useI18n()
  const { description, enabledByDefault } = spec
  const secrets = spec.type === 'stdio' ? spec.env : spec.headers
  const [secretText, setSecretText] = useState(toLines(secrets))
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<McpTestResult | null>(null)
  const invalid = badLines(secretText)

  async function runTest() {
    setTesting(true)
    setTest(null)
    try {
      setTest(await libraryApiFor(projectId).testMcp(spec, editing ?? undefined))
    } catch (err) {
      setTest({ ok: false, error: err instanceof Error ? err.message : t('error.unexpected') })
    } finally {
      setTesting(false)
    }
  }

  const setSecrets = (text: string) => {
    setSecretText(text)
    setTest(null)
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
          onChange={(e) => {
            const bad = badLines(e.target.value)
            e.target.setCustomValidity(bad.length ? t('editor.badLines', { lines: bad.join(', ') }) : '')
            setSecrets(e.target.value)
          }}
        />
      </label>
      {invalid.length > 0 && (
        <p className="error" role="alert">
          {t('editor.badLines', { lines: invalid.join(', ') })}
        </p>
      )}
      <p className="hint">
        {t('editor.secretsNote')}
        {editing !== null && ` ${t('editor.keepSaved')}`} {t('editor.envLead')}{' '}
        <code>{'${NAME}'}</code> {t('editor.envTail')}
      </p>
      <div className="row">
        <button
          type="button"
          className="secondary"
          disabled={testing || invalid.length > 0}
          onClick={runTest}
        >
          {t(testing ? 'editor.testing' : 'editor.test')}
        </button>
        {test && (
          <p className={test.ok ? 'hint' : 'error'} role="status">
            {test.ok
              ? t('editor.testOk', {
                  count: String(test.tools.length),
                  tools: test.tools.join(', ') || '—',
                })
              : t('editor.testFailed', { error: test.error })}
          </p>
        )}
      </div>
    </>
  )
}

type Step = WorkflowSpec['steps'][number]

/** The id a step runs with: its name, or `step-<n>` by position. */
const stepId = (step: Step, index: number) => step.id ?? `step-${index + 1}`

/**
 * Step `index` was renamed from `from`: the other steps follow it, in their
 * prompts and dependencies, unless the new name belongs to another step too.
 */
function followRename(steps: Step[], index: number, from: string): Step[] {
  const to = stepId(steps[index], index)
  if (from === to || steps.some((s, i) => i !== index && stepId(s, i) === to)) return steps
  return steps.map((s, i) =>
    i === index
      ? s
      : {
          ...s,
          prompt: s.prompt?.replaceAll(`{{steps.${from}}}`, `{{steps.${to}}}`),
          needs: s.needs?.map((n) => (n === from ? to : n)),
          repeat: s.repeat?.with === from ? { ...s.repeat, with: to } : s.repeat,
        },
  )
}

/** Removes step `index` and drops it from the others' dependencies and repeats. */
function removeStep(steps: Step[], index: number): Step[] {
  const id = stepId(steps[index], index)
  return steps
    .filter((_, i) => i !== index)
    .map((s) => ({
      ...s,
      needs: s.needs?.filter((n) => n !== id),
      repeat: s.repeat?.with === id ? undefined : s.repeat,
    }))
}

const parseValues = (text: string) =>
  text
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)

/** Approval, verdicts and repeat of a step, folded away until used. */
function StepOptions({
  step,
  index,
  steps,
  task,
  onChange,
}: {
  step: Step
  index: number
  steps: Step[]
  task?: boolean
  onChange: (change: Partial<Step>) => void
}) {
  const { t } = useI18n()
  const values = (step.verdict ?? []).join(', ')
  // What is typed, while it still says the same as the step: "ok, " keeps its comma.
  const [draft, setDraft] = useState(values)
  const shown = parseValues(draft).join(', ') === values ? draft : values
  const others = steps.map((s, i) => stepId(s, i)).filter((_, i) => i !== index)
  const repeat = step.repeat
  const check = repeat && steps.find((s, i) => stepId(s, i) === repeat.with)
  const setRepeat = (change: Partial<NonNullable<Step['repeat']>>) =>
    repeat && onChange({ repeat: { ...repeat, ...change } })

  return (
    <details open={Boolean(step.approval || step.verdict || repeat || step.run || step.protect)}>
      <summary>{t('editor.advanced')}</summary>
      <div className="stack">
        {task && (
          <>
            <label>
              {t('editor.run')}
              <input
                value={(step.run ?? []).join(', ')}
                placeholder="build, lint, test"
                onChange={(e) => {
                  const parsed = parseValues(e.target.value)
                  onChange({ run: parsed.length ? parsed : undefined })
                }}
              />
            </label>
            <label>
              {t('editor.expect')}
              <select
                value={step.expect ?? 'pass'}
                onChange={(e) => onChange({ expect: e.target.value as Step['expect'] })}
              >
                <option value="pass">{t('editor.pass')}</option>
                <option value="fail">{t('editor.fail')}</option>
              </select>
            </label>
            <label>
              {t('editor.protect')}
              <input
                value={(step.protect ?? []).join(', ')}
                placeholder="tests"
                onChange={(e) => {
                  const parsed = parseValues(e.target.value)
                  onChange({ protect: parsed.length ? parsed : undefined })
                }}
              />
            </label>
          </>
        )}
        <label className="switch">
          <input
            type="checkbox"
            checked={step.approval ?? false}
            onChange={(e) => onChange({ approval: e.target.checked || undefined })}
          />
          {t('editor.stepApproval')}
        </label>
        <label>
          {t('editor.verdict')}
          <input
            value={shown}
            placeholder="ok, problemi"
            onChange={(e) => {
              setDraft(e.target.value)
              const parsed = parseValues(e.target.value)
              onChange({ verdict: parsed.length ? parsed : undefined })
            }}
          />
        </label>
        <label className="switch">
          <input
            type="checkbox"
            checked={Boolean(repeat)}
            onChange={(e) =>
              onChange({ repeat: e.target.checked ? { with: others[0] ?? '', until: '', max: 3 } : undefined })
            }
          />
          {t('editor.repeat')}
        </label>
        {repeat && (
          <div className="row">
            <label>
              {t('editor.repeatWith')}
              <select required value={repeat.with} onChange={(e) => setRepeat({ with: e.target.value, until: '' })}>
                {others.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('editor.repeatUntil')}
              <select required value={repeat.until} onChange={(e) => setRepeat({ until: e.target.value })}>
                <option value="">…</option>
                {(check?.verdict ?? []).map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('editor.repeatMax')}
              <input
                type="number"
                min={1}
                max={5}
                required
                value={repeat.max}
                onChange={(e) => setRepeat({ max: Number(e.target.value) })}
              />
            </label>
            {task && (
              <label>
                {t('editor.stop')}
                <input
                  value={(repeat.stop ?? []).join(', ')}
                  placeholder="test_errati"
                  onChange={(e) => {
                    const parsed = parseValues(e.target.value)
                    setRepeat({ stop: parsed.length ? parsed : undefined })
                  }}
                />
              </label>
            )}
            <select
              aria-label={t('editor.onMaxFail')}
              value={repeat.onMax ?? 'fail'}
              onChange={(e) => setRepeat({ onMax: e.target.value === 'continue' ? 'continue' : undefined })}
            >
              <option value="fail">{t('editor.onMaxFail')}</option>
              <option value="continue">{t('editor.onMaxContinue')}</option>
            </select>
          </div>
        )}
      </div>
    </details>
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
  const setStep = (index: number, change: Partial<Step>) =>
    onChange({
      ...spec,
      steps: spec.steps.map((s, i) => (i === index ? { ...s, ...change } : s)),
    })
  // References follow a rename once the field is left, not at each keystroke.
  const [renaming, setRenaming] = useState<string | null>(null)
  return (
    <>
      <label>
        {t('editor.inputLabel')}
        <input value={spec.input} onChange={(e) => onChange({ ...spec, input: e.target.value })} />
      </label>
      <label className="switch">
        <input
          type="checkbox"
          checked={Boolean(spec.task)}
          onChange={(e) =>
            onChange(
              e.target.checked
                ? { ...spec, task: true, result: spec.result ?? stepId(spec.steps.at(-1)!, spec.steps.length - 1) }
                : {
                    ...spec,
                    task: undefined,
                    result: undefined,
                    steps: spec.steps.map((s) => ({
                      ...s,
                      run: undefined,
                      expect: undefined,
                      protect: undefined,
                      repeat: s.repeat ? { ...s.repeat, stop: undefined } : undefined,
                    })),
                  },
            )
          }
        />
        {t('editor.taskModel')}
      </label>
      {spec.task && (
        <label>
          {t('editor.result')}
          <input
            value={spec.result ?? ''}
            placeholder="verify"
            onChange={(e) => onChange({ ...spec, result: e.target.value.trim() || undefined })}
          />
        </label>
      )}
      <fieldset className="checklist">
        <legend>{t('editor.stepsTitle')}</legend>
        <p className="hint">
          {t('editor.promptLead')} <code>{'{{input}}'}</code> {t('editor.inputMeans')}{' '}
          <code>{'{{previous}}'}</code> {t('editor.previousMeans')} <code>{'{{steps.<id>}}'}</code>{' '}
          {t('editor.stepsMeans')} <code>{'{{iteration}}'}</code> {t('editor.iterationMeans')}
        </p>
        <ol className="run-steps">
          {spec.steps.map((step, i) => (
            <li key={i}>
              <div className="row">
                <input
                  aria-label={t('editor.stepName')}
                  title={t('editor.stepNameHint')}
                  placeholder={`step-${i + 1}`}
                  pattern="[a-z0-9][a-z0-9\-]{0,63}"
                  value={step.id ?? ''}
                  onFocus={() => setRenaming(stepId(step, i))}
                  onChange={(e) => setStep(i, { id: e.target.value.trim() || undefined })}
                  onBlur={() => {
                    if (renaming !== null) onChange({ ...spec, steps: followRename(spec.steps, i, renaming) })
                    setRenaming(null)
                  }}
                />
                {spec.task ? (
                  <input
                    aria-label={t('chat.agentLabel')}
                    value={step.agent ?? ''}
                    placeholder="role:implementer"
                    onChange={(e) => setStep(i, { agent: e.target.value || undefined })}
                  />
                ) : (
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
                )}
                <button
                  type="button"
                  className="link danger"
                  disabled={spec.steps.length === 1}
                  onClick={() => onChange({ ...spec, steps: removeStep(spec.steps, i) })}
                >
                  {t('editor.remove')}
                </button>
              </div>
              <textarea
                aria-label={t('editor.prompt')}
                rows={4}
                required={!spec.task}
                value={step.prompt ?? ''}
                onChange={(e) => setStep(i, { prompt: e.target.value || undefined })}
              />
              <StepOptions
                step={step}
                index={i}
                steps={spec.steps}
                task={spec.task}
                onChange={(change) => setStep(i, change)}
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
