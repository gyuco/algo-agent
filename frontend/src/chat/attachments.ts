export interface Attachment {
  name: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'application/pdf' | 'text/plain'
  /** Base64 file content, without the data: URL prefix. */
  data: string
}

export const MAX_ATTACHMENTS = 5
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const TEXT_TYPES = ['application/json', 'application/xml', 'application/x-yaml', 'application/javascript']
const TEXT_EXTENSIONS =
  /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|css|scss|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|zsh|sql|toml|ini|env|log|graphql|vue|svelte)$/i

/** What the file input offers; the type check in `readAttachment` is what counts. */
export const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.csv,.json,.yaml,.yml,.xml,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.sql,.sh,.toml'

function mediaTypeOf(file: File): Attachment['mediaType'] | null {
  if (IMAGE_TYPES.includes(file.type)) return file.type as Attachment['mediaType']
  if (file.type === 'application/pdf') return 'application/pdf'
  if (file.type.startsWith('text/') || TEXT_TYPES.includes(file.type) || TEXT_EXTENSIONS.test(file.name)) {
    return 'text/plain'
  }
  return null
}

/** Reads a file for the chat, or throws a message explaining why it can't be attached. */
export async function readAttachment(file: File): Promise<Attachment> {
  const mediaType = mediaTypeOf(file)
  if (!mediaType) throw new Error(`${file.name}: tipo di file non supportato`)
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name}: supera i 5 MB`)
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error(`${file.name}: lettura non riuscita`))
    reader.readAsDataURL(file)
  })
  return { name: file.name || 'incollato.png', mediaType, data: dataUrl.slice(dataUrl.indexOf(',') + 1) }
}

export function isImage(a: Attachment) {
  return a.mediaType.startsWith('image/')
}

export function previewUrl(a: Attachment) {
  return `data:${a.mediaType};base64,${a.data}`
}
