/** Default icon colour, the gradient-less purple used when a project has no colour. */
export const DEFAULT_PROJECT_COLOR = '#7c3aed'

/** The project's logo, or its initial on the chosen colour. */
export function ProjectIcon({
  name,
  color,
  logo,
  className = '',
}: {
  name: string
  color?: string | null
  logo?: string | null
  className?: string
}) {
  const classes = `project-icon ${className}`.trim()
  if (logo) {
    return <img className={`${classes} project-logo`} src={logo} alt="" aria-hidden="true" />
  }
  return (
    <span
      className={classes}
      style={color ? { background: color } : undefined}
      aria-hidden="true"
    >
      {(name.trim().slice(0, 1) || '?').toUpperCase()}
    </span>
  )
}
