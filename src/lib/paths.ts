/** Имена и пути для собираемых архивов. Общие: их спрашивают и с экрана доменов, и из редактора. */

/** `2026-08-27-1043` — метка в имени архива, по местному времени. */
export function localStamp(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

/** `2026-08-27T21:15:04` — местное время, тем же порядком, что у сервера. */
export function localTime(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

/**
 * Папка, в которую логично положить новый архив: рядом с исходной выгрузкой.
 * Для `…/config-X/domains` это `…/`, для `…/config-X.zip` — тоже `…/`.
 */
export function folderBesideExport(source: string): string {
  const separator = source.includes('\\') && !source.includes('/') ? '\\' : '/'
  const parts = source.split(/[/\\]/).filter(Boolean)
  const last = parts[parts.length - 1] ?? ''
  // Файл архива и папка конфигурации лежат на одном уровне, папка domains — на уровень глубже.
  const up = last === 'domains' ? 2 : 1
  const kept = parts.slice(0, Math.max(parts.length - up, 0))
  const prefix = source.startsWith('/') ? '/' : ''
  return kept.length > 0 ? `${prefix}${kept.join(separator)}${separator}` : prefix
}
