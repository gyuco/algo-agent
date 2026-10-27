import { createContext } from 'react'

export interface User {
  id: number
  email: string
  createdAt: string
}

export interface AuthResponse {
  accessToken: string
  user: User
}

export interface AuthState {
  user: User | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string) => Promise<void>
  logout: () => void
}

export const AuthContext = createContext<AuthState | null>(null)
