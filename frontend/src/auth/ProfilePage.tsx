import { LOCALES } from '../i18n/messages'
import { useI18n } from '../i18n/useI18n'
import { useAuth } from './useAuth'

/** The signed-in account: who you are and since when. */
export function ProfilePage() {
  const { user } = useAuth()
  const { t, language } = useI18n()
  if (!user) return null

  const name = user.email.split('@')[0]
  const since = user.createdAt
    ? new Date(user.createdAt).toLocaleDateString(LOCALES[language], { dateStyle: 'long' })
    : null

  return (
    <section className="card profile">
      <div className="profile-head">
        <span className="avatar avatar-lg" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <div className="profile-identity">
          <h1>{name}</h1>
          <p className="hint">{user.email}</p>
        </div>
      </div>
      {since && (
        <dl className="facts">
          <div>
            <dt>{t('profile.memberSince')}</dt>
            <dd>{since}</dd>
          </div>
        </dl>
      )}
    </section>
  )
}
