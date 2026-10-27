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

/** POSTs `body` and yields each Server-Sent Event's JSON payload as it arrives. */
export async function* apiStream<T>(
  path: string,
  body: unknown,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal,
  })
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
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n')
      if (data) yield JSON.parse(data) as T
    }
  }
}
