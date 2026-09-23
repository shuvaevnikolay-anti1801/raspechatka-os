/** Format an employee name for the fiscal operator field. */
export function formatPersonShortName(value?: string | null): string {
  const parts = (value ?? '').trim().split(/\s+/u).filter(Boolean)
  if (parts.length <= 1) return parts[0] ?? ''

  const [surname, ...names] = parts
  const initials = names.slice(0, 2).map((part) => {
    const letter = Array.from(part.replace(/\./gu, ''))[0]
    return letter ? letter + '.' : ''
  }).filter(Boolean)
  return initials.length ? surname + ' ' + initials.join(' ') : surname
}
