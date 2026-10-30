import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { EditIcon, TrashIcon } from '../components/Icons'
import { useI18n } from '../i18n/useI18n'
import { vaultApiFor, type SecretInfo } from './api'

interface Props {
  /** null: the user's own secrets. */
  projectId: number | null
  /** Called with every name a run here can use, the user's and the project's. */
  onNames?: (names: string[]) => void
}

const NAME = '[A-Za-z_][A-Za-z0-9_]{0,63}'

/**
 * Named secrets that MCP servers use as `${NAME}`. Values are write-only: the
 * server shows only a hint, and replacing means typing the whole value again.
 */
export function SecretsPanel({ projectId, onNames }: Props) {
  const { t } = useI18n()
  const [secrets, setSecrets] = useState<SecretInfo[] | null>(null)
  /** In a project: the user's own, which the project's override. */
  const [inherited, setInherited] = useState<SecretInfo[]>([])
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  /** Name being replaced; its value is typed in the form above. */
  const [replacing, setReplacing] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fail = useCallback(
    (err: unknown) => setError(err instanceof Error ? err.message : t('secrets.failed')),
    [t],
  )

  const load = useCallback(() => {
    const own = vaultApiFor(projectId).list()
    const user = projectId === null ? Promise.resolve([]) : vaultApiFor(null).list()
    Promise.all([own, user]).then(([mine, theirs]) => {
      setSecrets(mine)
      setInherited(theirs)
      onNames?.([...new Set([...mine, ...theirs].map((s) => s.name))])
    }, fail)
  }, [projectId, onNames, fail])

  useEffect(load, [load])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await vaultApiFor(projectId).set(replacing ?? name.trim(), value)
      setName('')
      setValue('')
      setReplacing(null)
      load()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function remove(target: string) {
    setDeleting(null)
    setError(null)
    try {
      await vaultApiFor(projectId).remove(target)
      load()
    } catch (err) {
      fail(err)
    }
  }

  const overridden = new Set(secrets?.map((s) => s.name))

  return (
    <section className="card resources secrets">
      <h2>{t(projectId === null ? 'secrets.userTitle' : 'secrets.projectTitle')}</h2>
      <p className="hint">
        {t('secrets.introLead')} <code>{'${NAME}'}</code>{' '}
        {t(projectId === null ? 'secrets.userIntro' : 'secrets.projectIntro')}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {secrets === null ? (
        <p className="hint">{t('app.loading')}</p>
      ) : secrets.length === 0 ? (
        <p className="hint">{t('library.none')}</p>
      ) : (
        <ul className="resource-list">
          {secrets.map((s) => (
            <li key={s.name}>
              <div className="row">
                <code className="grow">{s.name}</code>
                <span className="hint">{s.hint}</span>
                {deleting === s.name ? (
                  <>
                    <span className="hint">{t('library.confirmDelete', { name: s.name })}</span>
                    <button type="button" className="secondary" onClick={() => setDeleting(null)}>
                      {t('projects.cancel')}
                    </button>
                    <button
                      type="button"
                      className="danger icon-action"
                      aria-label={t('projects.delete')}
                      title={t('projects.delete')}
                      onClick={() => void remove(s.name)}
                    >
                      <TrashIcon />
                    </button>
                  </>
                ) : (
                  <span className="row-actions">
                    <button
                      type="button"
                      className="link icon-action"
                      aria-label={t('secrets.replace')}
                      title={t('secrets.replace')}
                      onClick={() => {
                        setReplacing(s.name)
                        setValue('')
                      }}
                    >
                      <EditIcon />
                    </button>
                    <button
                      type="button"
                      className="link danger icon-action"
                      aria-label={t('projects.delete')}
                      title={t('projects.delete')}
                      onClick={() => setDeleting(s.name)}
                    >
                      <TrashIcon />
                    </button>
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {inherited.length > 0 && (
        <p className="hint">
          {t('secrets.inherited')}{' '}
          {inherited.map((s, i) => (
            <span key={s.name} className={overridden.has(s.name) ? 'overridden' : undefined}>
              {i > 0 && ', '}
              <code>{s.name}</code>
            </span>
          ))}{' '}
          — <a href="#/resources">{t('resources.tabLink')}</a>
        </p>
      )}
      <form className="row secret-form" onSubmit={submit} autoComplete="off">
        {replacing ? (
          <code>{replacing}</code>
        ) : (
          <input
            aria-label={t('secrets.name')}
            placeholder={t('secrets.name')}
            value={name}
            required
            pattern={NAME}
            title={t('secrets.nameHint')}
            onChange={(e) => setName(e.target.value)}
          />
        )}
        <input
          className="grow"
          type="password"
          aria-label={t('secrets.value')}
          placeholder={t('secrets.value')}
          autoComplete="new-password"
          value={value}
          required
          onChange={(e) => setValue(e.target.value)}
        />
        {replacing && (
          <button type="button" className="secondary" onClick={() => setReplacing(null)}>
            {t('projects.cancel')}
          </button>
        )}
        <button type="submit" disabled={busy}>
          {t(replacing ? 'secrets.replace' : 'secrets.add')}
        </button>
      </form>
    </section>
  )
}
