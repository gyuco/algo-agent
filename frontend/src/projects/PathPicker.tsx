import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import { projectsApi, type FolderListing } from './api'

interface Props {
  /** Folder to open first; the workspace root when empty or invalid. */
  initialPath: string
  onSelect: (path: string) => void
  onClose: () => void
}

/** Modal folder browser over the backend's workspace root. */
export function PathPicker({ initialPath, onSelect, onClose }: Props) {
  const { t } = useI18n()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [listing, setListing] = useState<FolderListing | null>(null)
  /** '' means a failure without a server message. */
  const [error, setError] = useState<string | null>(null)
  const [startPath] = useState(initialPath)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  async function open(path?: string) {
    setLoading(true)
    setError(null)
    try {
      setListing(await projectsApi.browse(path))
    } catch (err) {
      setError(err instanceof Error ? err.message : '')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // Fall back to the root when the typed path can't be opened.
    projectsApi
      .browse(startPath || undefined)
      .catch(() => projectsApi.browse())
      .then(setListing, (err: unknown) => setError(err instanceof Error ? err.message : ''))
  }, [startPath])

  const join = (name: string) => `${listing!.path.replace(/\/$/, '')}/${name}`

  return (
    <dialog ref={dialogRef} className="picker" onClose={onClose} aria-labelledby="picker-title">
      <h2 id="picker-title">{t('picker.title')}</h2>
      {listing && (
        <code className="picker-path" title={listing.path}>
          {listing.path}
        </code>
      )}
      {error !== null && (
        <p className="error" role="alert">
          {error || t('picker.error')}
        </p>
      )}
      <ul className="folders" aria-busy={loading}>
        {listing?.parent && (
          <li>
            <button
              type="button"
              className="folder"
              disabled={loading}
              onClick={() => void open(listing.parent!)}
            >
              ↑ {t('picker.up')}
            </button>
          </li>
        )}
        {listing?.folders.map((name) => (
          <li key={name}>
            <button
              type="button"
              className="folder"
              disabled={loading}
              onClick={() => void open(join(name))}
            >
              {name}/
            </button>
          </li>
        ))}
        {listing && listing.folders.length === 0 && <li className="hint">{t('picker.empty')}</li>}
      </ul>
      <div className="row end">
        <button type="button" className="secondary" onClick={() => dialogRef.current?.close()}>
          {t('projects.cancel')}
        </button>
        <button
          type="button"
          disabled={!listing || loading}
          onClick={() => {
            onSelect(listing!.path)
            dialogRef.current?.close()
          }}
        >
          {t('picker.select')}
        </button>
      </div>
    </dialog>
  )
}
