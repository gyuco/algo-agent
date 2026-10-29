import { useMemo, useState } from 'react'
import { useI18n } from '../i18n/useI18n'

interface FileDiff {
  path: string
  lines: string[]
}

/** Splits a unified diff into files, keeping the hunk lines. */
function parse(diff: string): FileDiff[] {
  const files: FileDiff[] = []
  let current: FileDiff | null = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = / b\/(.+)$/.exec(line)
      current = { path: match?.[1] ?? line.slice(11), lines: [] }
      files.push(current)
      continue
    }
    if (!current) {
      current = { path: 'diff', lines: [] }
      files.push(current)
    }
    if (line.startsWith('+++ b/')) current.path = line.slice(6)
    current.lines.push(line)
  }
  return files
}

/** A unified diff with files that open and close; nothing but CSS colours the lines. */
export function DiffView({ diff }: { diff: string }) {
  const { t } = useI18n()
  const files = useMemo(() => parse(diff), [diff])
  const [open, setOpen] = useState<Set<string>>(() => new Set(files.map((f) => f.path)))

  if (!diff.trim()) return <p className="hint">{t('missions.diff.empty')}</p>

  const toggle = (path: string) =>
    setOpen((set) => {
      const next = new Set(set)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  return (
    <div className="diff-view">
      {files.map((file) => (
        <div key={file.path} className="diff-file">
          <button type="button" className="link" onClick={() => toggle(file.path)}>
            {open.has(file.path) ? '▾' : '▸'} {file.path}
          </button>
          {open.has(file.path) && (
            <pre className="diff-body">
              {file.lines.map((line, i) => (
                <span
                  key={i}
                  className={
                    line.startsWith('+') && !line.startsWith('+++')
                      ? 'diff-add'
                      : line.startsWith('-') && !line.startsWith('---')
                        ? 'diff-del'
                        : line.startsWith('@@')
                          ? 'diff-hunk'
                          : undefined
                  }
                >
                  {line}
                  {'\n'}
                </span>
              ))}
            </pre>
          )}
        </div>
      ))}
    </div>
  )
}
