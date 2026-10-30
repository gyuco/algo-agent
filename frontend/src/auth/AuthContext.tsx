import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { api, tokenStore } from '../api/client'
import {
  AuthContext,
  type AuthResponse,
  type AuthState,
  type ProfileUpdate,
  type User,
} from './context'

/** Replaces the query string, keeping the hash routing the app relies on. */
function replaceQuery(params: Record<string, string>): void {
  const url = new URL(window.location.href)
  url.search = new URLSearchParams(params).toString()
  window.history.replaceState(null, '', url.toString())
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  // The Google callback redirects here with a one-time code: redeem it before showing the app.
  const [googleCode] = useState(
    () => new URLSearchParams(window.location.search).get('code'),
  )
  const [loading, setLoading] = useState(
    () => googleCode !== null || tokenStore.get() !== null,
  )

  useEffect(() => {
    if (googleCode !== null) {
      api<AuthResponse>('/auth/google/exchange', {
        method: 'POST',
        body: JSON.stringify({ code: googleCode }),
      })
        .then((res) => {
          tokenStore.set(res.accessToken)
          setUser(res.user)
          replaceQuery({})
        })
        .catch(() => {
          // Back to the login page, which reads the reason and shows it.
          replaceQuery({ google: 'error', reason: 'failed' })
        })
        .finally(() => setLoading(false))
      return
    }
    if (!tokenStore.get()) return
    api<User>('/auth/me')
      .then(setUser)
      .catch(() => tokenStore.clear())
      .finally(() => setLoading(false))
  }, [googleCode])

  const authenticate = useCallback(
    async (path: string, email: string, password: string) => {
      const res = await api<AuthResponse>(path, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
      tokenStore.set(res.accessToken)
      setUser(res.user)
    },
    [],
  )

  const updateProfile = useCallback(async (data: ProfileUpdate) => {
    const res = await api<AuthResponse>('/auth/me', {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
    // The email is part of the token payload: swap it for the freshly issued one.
    tokenStore.set(res.accessToken)
    setUser(res.user)
    return res.user
  }, [])

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      await api<null>('/auth/me/password', {
        method: 'PATCH',
        body: JSON.stringify({ currentPassword, newPassword }),
      })
    },
    [],
  )

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      login: (email, password) => authenticate('/auth/login', email, password),
      register: (email, password) =>
        authenticate('/auth/register', email, password),
      logout: () => {
        tokenStore.clear()
        setUser(null)
      },
      updateProfile,
      changePassword,
    }),
    [user, loading, authenticate, updateProfile, changePassword],
  )

  return <AuthContext value={value}>{children}</AuthContext>
}
