import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../api/client'
import { useAuth } from './useAuth'

export function LoginPage() {
  const { login, register } = useAuth()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [registrationOpen, setRegistrationOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    api<{ open: boolean }>('/auth/registration')
      .then(({ open }) => {
        setRegistrationOpen(open)
        if (open) setMode('register')
      })
      .catch(() => setRegistrationOpen(false))
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await (mode === 'login' ? login : register)(email, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore imprevisto')
    } finally {
      setSubmitting(false)
    }
  }

  const isLogin = mode === 'login'

  return (
    <main className="auth">
      <form className="card" onSubmit={onSubmit}>
        <h1>{isLogin ? 'Accedi' : 'Crea account'}</h1>
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={isLogin ? 'current-password' : 'new-password'}
            required
            minLength={8}
            maxLength={72}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={submitting}>
          {submitting ? 'Attendere…' : isLogin ? 'Accedi' : 'Registrati'}
        </button>
        {registrationOpen && (
          <button
            type="button"
            className="link"
            onClick={() => setMode(isLogin ? 'register' : 'login')}
          >
            {isLogin ? 'Non hai un account? Registrati' : 'Hai già un account? Accedi'}
          </button>
        )}
      </form>
    </main>
  )
}
