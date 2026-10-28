const TOKEN_KEY = 'accessToken'

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}

function headers(init: RequestInit = {}): HeadersInit {
  const token = tokenStore.get()
  return {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` }),
    ...init.headers,
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  const body = await res.json().catch(() => null)
  const message = Array.isArray(body?.message)
    ? body.message.join(', ')
    : (body?.message ?? res.statusText)
  return new ApiError(res.status, message)
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, { ...init, headers: headers(init) })
  if (!res.ok) throw await toApiError(res)
  return (await res.json().catch(() => null)) as T
}

/** One Server-Sent Event: its `id`, when the server sent one, and its JSON payload. */
export interface StreamEvent<T> {
  id: number | null
  data: T
}

/** GETs `path` and yields each Server-Sent Event as it arrives, until the server ends the stream. */
export async function* apiEvents<T>(path: string, signal: AbortSignal): AsyncGenerator<StreamEvent<T>> {
  const res = await fetch(`/api${path}`, { headers: headers(), signal })
  if (!res.ok) throw await toApiError(res)
  if (!res.body) return

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buffer += value
    let end: number
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const lines = buffer.slice(0, end).split('\n')
      buffer = buffer.slice(end + 2)
      const data = lines
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n')
      const id = lines.find((line) => line.startsWith('id: '))
      // Lines starting with ':' are keep-alive comments.
      if (data) yield { id: id ? Number(id.slice(4)) : null, data: JSON.parse(data) as T }
    }
  }
}
