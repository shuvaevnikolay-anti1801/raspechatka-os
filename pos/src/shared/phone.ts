export function normalizeRussianPhone(value: string | null | undefined): string {
  let digits = String(value ?? '').replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`
  if (digits.length === 10) digits = `7${digits}`
  return digits.length === 11 && digits.startsWith('7') ? `+${digits}` : ''
}
