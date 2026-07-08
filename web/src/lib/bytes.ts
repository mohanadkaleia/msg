// lib/bytes.ts — a tiny human-readable byte formatter for attachment chips/cards
// (ENG-121). Pure + display-only: the value is rendered ONLY through Vue text
// interpolation (never a raw sink), and the input is a numeric `size` off a `File`
// or a projected `FileRow.size_bytes`, never attacker-controlled markup.

/** Format a byte count as e.g. `827 B`, `1.4 KB`, `3.2 MB`. Empty for a bad input. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}
