import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/useI18n'

/** First letter of the local part of the email, used in the avatar. */
function initial(email: string) {
  return email.slice(0, 1).toUpperCase()
}

/** Header avatar: opens a menu with the account, the profile and logout. */
export function UserMenu({ email, onLogout }: { email: string; onLogout: () => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        trigger.current?.focus()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const items = popover.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')
      if (!items?.length) return
      e.preventDefault()
      const list = Array.from(items)
      const index = list.indexOf(document.activeElement as HTMLElement)
      const next =
        e.key === 'ArrowDown'
          ? (index + 1) % list.length
          : (index - 1 + list.length) % list.length
      list[index === -1 ? 0 : next]?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // The profile link and browser navigation change the route: close the menu.
  useEffect(() => {
    const close = () => setOpen(false)
    window.addEventListener('hashchange', close)
    return () => window.removeEventListener('hashchange', close)
  }, [])

  useEffect(() => {
    if (open) popover.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [open])

  return (
    <div className="user-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="avatar"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('user.menu')}
        title={email}
        onClick={() => setOpen((value) => !value)}
      >
        {initial(email)}
      </button>
      {open && (
        <div className="user-menu-popover" role="menu" aria-label={t('user.menu')} ref={popover}>
          <div className="user-menu-account">
            <span className="avatar" aria-hidden="true">
              {initial(email)}
            </span>
            <span className="user-menu-email">{email}</span>
          </div>
          <a
            role="menuitem"
            className="user-menu-item"
            href="#/profile"
            onClick={() => setOpen(false)}
          >
            {t('user.profile')}
          </a>
          <button
            type="button"
            role="menuitem"
            className="user-menu-item logout"
            onClick={() => {
              setOpen(false)
              onLogout()
            }}
          >
            {t('app.logout')}
          </button>
        </div>
      )}
    </div>
  )
}
