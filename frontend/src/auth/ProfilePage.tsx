import { useState, type FormEvent } from 'react'
import { LOCALES } from '../i18n/messages'
import { useI18n } from '../i18n/useI18n'
import { useAuth } from './useAuth'

/** The signed-in account: who you are, and where you change your details and password. */
export function ProfilePage() {
  const { user, updateProfile, changePassword } = useAuth()
  const { t, language } = useI18n()

  const [name, setName] = useState(user?.name ?? '')
  const [email, setEmail] = useState(user?.email ?? '')
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [profileSaved, setProfileSaved] = useState(false)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordChanged, setPasswordChanged] = useState(false)

  if (!user) return null

  const displayName = user.name?.trim() || user.email.split('@')[0]
  const initial = (displayName || user.email).slice(0, 1).toUpperCase()
  const since = user.createdAt
    ? new Date(user.createdAt).toLocaleDateString(LOCALES[language], {
        dateStyle: 'long',
      })
    : null

  async function onSaveProfile(e: FormEvent) {
    e.preventDefault()
    setProfileError(null)
    setProfileSaved(false)
    setSavingProfile(true)
    try {
      const updated = await updateProfile({ name: name.trim(), email: email.trim() })
      // Show what the server stored: it trims and lowercases the email.
      setName(updated.name ?? '')
      setEmail(updated.email)
      setProfileSaved(true)
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : t('error.unexpected'))
    } finally {
      setSavingProfile(false)
    }
  }

  async function onChangePassword(e: FormEvent) {
    e.preventDefault()
    setPasswordError(null)
    setPasswordChanged(false)
    if (newPassword !== confirmPassword) {
      setPasswordError(t('profile.passwordMismatch'))
      return
    }
    setChangingPassword(true)
    try {
      await changePassword(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setPasswordChanged(true)
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : t('error.unexpected'))
    } finally {
      setChangingPassword(false)
    }
  }

  return (
    <div className="profile">
      <section className="card profile-hero">
        <span className="avatar avatar-xl" aria-hidden="true">
          {initial}
        </span>
        <div className="profile-hero-text">
          <h1>{displayName}</h1>
          <p className="profile-email">{user.email}</p>
          {since && (
            <p className="profile-since">
              {t('profile.memberSince')} <span>{since}</span>
            </p>
          )}
        </div>
      </section>

      <div className="profile-grid">
        <section className="card profile-card">
          <header className="profile-card-head">
            <h2>{t('profile.account')}</h2>
            <p className="hint">{t('profile.accountHint')}</p>
          </header>
          <form className="profile-form" onSubmit={onSaveProfile}>
            <label>
              {t('profile.name')}
              <input
                type="text"
                autoComplete="name"
                maxLength={80}
                placeholder={t('profile.namePlaceholder')}
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setProfileSaved(false)
                }}
              />
            </label>
            <label>
              {t('profile.email')}
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value)
                  setProfileSaved(false)
                }}
              />
            </label>
            {profileError && (
              <p className="error" role="alert">
                {profileError}
              </p>
            )}
            <div className="profile-actions">
              {profileSaved && (
                <p className="success" role="status">
                  {t('profile.saved')}
                </p>
              )}
              <button type="submit" disabled={savingProfile}>
                {savingProfile ? t('profile.saving') : t('profile.save')}
              </button>
            </div>
          </form>
        </section>

        <section className="card profile-card">
          <header className="profile-card-head">
            <h2>{t('profile.security')}</h2>
            <p className="hint">{t('profile.securityHint')}</p>
          </header>
          <form className="profile-form" onSubmit={onChangePassword}>
            <label>
              {t('profile.currentPassword')}
              <input
                type="password"
                autoComplete="current-password"
                required
                maxLength={72}
                value={currentPassword}
                onChange={(e) => {
                  setCurrentPassword(e.target.value)
                  setPasswordChanged(false)
                }}
              />
            </label>
            <label>
              {t('profile.newPassword')}
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={72}
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value)
                  setPasswordChanged(false)
                }}
              />
            </label>
            <label>
              {t('profile.confirmPassword')}
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={72}
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value)
                  setPasswordChanged(false)
                }}
              />
            </label>
            <p className="hint">{t('profile.passwordHint')}</p>
            {passwordError && (
              <p className="error" role="alert">
                {passwordError}
              </p>
            )}
            <div className="profile-actions">
              {passwordChanged && (
                <p className="success" role="status">
                  {t('profile.passwordChanged')}
                </p>
              )}
              <button type="submit" disabled={changingPassword}>
                {changingPassword
                  ? t('profile.changingPassword')
                  : t('profile.changePassword')}
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  )
}
