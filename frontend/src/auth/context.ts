import { createContext } from 'react'

export interface User {
  id: number
  email: string
  name: string | null
  createdAt: string
}

export interface AuthResponse {
  accessToken: string
  user: User
}

/** The account fields the profile page can change. */
export interface ProfileUpdate {
  name?: string
  email?: string
}

export interface AuthState {
  user: User | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string) => Promise<void>
  logout: () => void
  updateProfile: (data: ProfileUpdate) => Promise<User>
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
}

export const AuthContext = createContext<AuthState | null>(null)
