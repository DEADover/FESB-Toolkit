import { LANGUAGES, useI18n, type Language, type MessageKey } from '../i18n'
import type { ThemeMode } from '../lib/theme'
import type { AppInfo } from '../types'
import { Badge, Segmented, cx } from './ui'

export type ScreenId = 'files.trace' | 'api.connection' | 'api.domains' | 'api.trace'

interface Section {
  title: MessageKey
  soon?: boolean
  items: Array<{ id: ScreenId; label: MessageKey; hint: MessageKey; icon: string; disabled?: boolean }>
}

const SECTIONS: Section[] = [
  {
    title: 'nav.files',
    items: [
      { id: 'files.trace', label: 'nav.files.trace', hint: 'nav.files.trace.hint', icon: '◎' },
    ],
  },
  {
    title: 'nav.api',
    soon: true,
    items: [
      { id: 'api.connection', label: 'nav.api.connection', hint: 'nav.api.connection.hint', icon: '⇄', disabled: true },
      { id: 'api.domains', label: 'nav.api.domains', hint: 'nav.api.domains.hint', icon: '▤', disabled: true },
      { id: 'api.trace', label: 'nav.api.trace', hint: 'nav.api.trace.hint', icon: '◎', disabled: true },
    ],
  },
]

interface Props {
  screen: ScreenId
  onScreen: (screen: ScreenId) => void
  info: AppInfo | null
  isMac: boolean
  themeMode: ThemeMode
  onThemeMode: (mode: ThemeMode) => void
}

export function Sidebar({ screen, onScreen, info, isMac, themeMode, onThemeMode }: Props) {
  const { t, language, setLanguage } = useI18n()

  return (
    <aside
      data-tauri-drag-region
      className={cx('flex w-60 shrink-0 flex-col border-r border-line bg-surface', isMac ? 'pt-9' : 'pt-4')}
    >
      <div className="px-4 pb-5">
        <div className="flex items-center gap-2.5">
          <Logo />
          <div className="whitespace-nowrap text-[13px] font-semibold">{t('app.name')}</div>
        </div>
      </div>

      <nav className="flex flex-col gap-5 overflow-y-auto px-2">
        {SECTIONS.map((section) => (
          <div key={section.title}>
            <div className="mb-1.5 flex items-center gap-2 px-2.5">
              <span className="text-[11px] font-semibold tracking-wide text-content-subtle">{t(section.title)}</span>
              {section.soon && <Badge>{t('nav.soon')}</Badge>}
            </div>
            <div className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  disabled={item.disabled}
                  onClick={() => onScreen(item.id)}
                  className={cx(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition',
                    item.disabled && 'cursor-not-allowed opacity-45',
                    screen === item.id ? 'bg-accent/12 text-content' : 'text-content-muted',
                    !item.disabled && screen !== item.id && 'hover:bg-surface-3',
                  )}
                >
                  <span
                    className={cx(
                      'grid size-7 shrink-0 place-items-center rounded-md text-[13px]',
                      screen === item.id ? 'bg-accent/20 text-accent-content' : 'bg-surface-2 text-content-subtle',
                    )}
                  >
                    {item.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium">{t(item.label)}</span>
                    <span className="block truncate text-[10.5px] text-content-subtle">{t(item.hint)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-2.5 px-4 py-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-content-subtle">{t('settings.theme')}</span>
          <Segmented<ThemeMode>
            ariaLabel={t('settings.theme')}
            value={themeMode}
            onChange={onThemeMode}
            options={[
              { id: 'system', label: '◐', title: t('settings.theme.system') },
              { id: 'light', label: '☀', title: t('settings.theme.light') },
              { id: 'dark', label: '☾', title: t('settings.theme.dark') },
            ]}
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-content-subtle">{t('settings.language')}</span>
          <Segmented<Language>
            ariaLabel={t('settings.language')}
            value={language}
            onChange={setLanguage}
            options={LANGUAGES.map((item) => ({ id: item.id, label: item.id.toUpperCase(), title: item.label }))}
          />
        </div>
        <div className="text-[10.5px] leading-relaxed text-content-subtle">
          {info ? `v${info.version} · Tauri ${info.tauri} · ${info.platform}` : '—'}
        </div>
      </div>
    </aside>
  )
}

function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="size-8" aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-surface-3" />
      <g className="stroke-accent-strong" strokeWidth="1.6">
        <path d="M16 16 16 9M16 16 22 19.5M16 16 10 19.5" />
      </g>
      <g className="fill-surface-3 stroke-accent" strokeWidth="1.6">
        <circle cx="16" cy="8.5" r="2.6" />
        <circle cx="22.5" cy="20" r="2.6" />
        <circle cx="9.5" cy="20" r="2.6" />
      </g>
      <circle cx="16" cy="16" r="4.2" className="fill-accent" />
      <circle cx="16" cy="16" r="1.9" className="fill-surface-3" />
    </svg>
  )
}
