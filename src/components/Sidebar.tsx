import { LANGUAGES, useI18n, type Language, type MessageKey } from '../i18n'
import type { ThemeMode } from '../lib/theme'
import type { AppInfo } from '../types'
import { Segmented, cx } from './ui'

export type ScreenId =
  | 'files.trace'
  | 'files.links'
  | 'api.connection'
  | 'api.domains'
  | 'api.map'
  | 'api.routes'
  | 'api.queues'
  | 'api.modules'
  | 'api.properties'
  | 'api.logs'
  | 'api.audit'

interface Section {
  title: MessageKey
  /** Экран настроек раздела — открывается шестерёнкой у заголовка. */
  settings?: { screen: ScreenId; title: MessageKey }
  items: Array<{ id: ScreenId; label: MessageKey; icon: string; disabled?: boolean }>
}

const SECTIONS: Section[] = [
  {
    title: 'nav.files',
    items: [
      { id: 'files.trace', label: 'nav.files.trace', icon: '◎' },
      { id: 'files.links', label: 'nav.files.links', icon: '⇄' },
    ],
  },
  {
    title: 'nav.api',
    settings: { screen: 'api.connection', title: 'nav.api.connection.title' },
    items: [
      { id: 'api.map', label: 'nav.api.map', icon: '◫' },
      { id: 'api.domains', label: 'nav.api.domains', icon: '▤' },
      { id: 'api.routes', label: 'nav.api.routes', icon: '⇉' },
      { id: 'api.queues', label: 'nav.api.queues', icon: '≡' },
      { id: 'api.modules', label: 'nav.api.modules', icon: '⬒' },
      { id: 'api.properties', label: 'nav.api.properties', icon: '◈' },
      { id: 'api.logs', label: 'nav.api.logs', icon: '☰' },
      { id: 'api.audit', label: 'nav.api.audit', icon: '✓' },
    ],
  },
]

interface Props {
  screen: ScreenId
  onScreen: (screen: ScreenId) => void
  info: AppInfo | null
  isMac: boolean
  collapsed: boolean
  onCollapse: () => void
  themeMode: ThemeMode
  onThemeMode: (mode: ThemeMode) => void
}

/**
 * Боковая панель сворачивается не в ноль, а в узкую полосу: кнопка раскрытия
 * остаётся на своём месте, и переключаться между режимами можно не сходя с него.
 */
export function Sidebar({ screen, onScreen, info, isMac, collapsed, onCollapse, themeMode, onThemeMode }: Props) {
  const { t, language, setLanguage } = useI18n()

  return (
    <aside
      className={cx(
        'shrink-0 overflow-hidden border-r border-line bg-surface transition-[width] duration-300 ease-out',
        collapsed ? 'w-14' : 'w-60',
      )}
    >
      <div data-tauri-drag-region className={cx('flex h-full flex-col', isMac ? 'pt-9' : 'pt-4')}>
        <div className={cx('flex items-center gap-2.5 pb-5', collapsed ? 'flex-col px-2' : 'px-4')}>
          <Logo />
          {!collapsed && <div className="min-w-0 flex-1 truncate text-[13px] font-semibold">{t('app.name')}</div>}
          <button
            type="button"
            onClick={onCollapse}
            aria-label={collapsed ? t('action.showSidebar') : t('action.hideSidebar')}
            title={collapsed ? t('action.showSidebar') : t('action.hideSidebar')}
            className="grid size-6 shrink-0 place-items-center rounded-md text-[13px] text-content-subtle transition hover:bg-surface-3 hover:text-content"
          >
            {collapsed ? '›' : '‹'}
          </button>
        </div>

        <nav className={cx('flex flex-col overflow-y-auto', collapsed ? 'gap-2 px-2' : 'gap-5 px-2')}>
          {SECTIONS.map((section) => (
            <div key={section.title}>
              {collapsed ? (
                // В узком режиме заголовок раздела не помещается — вместо него разделитель.
                <div className="mx-auto mb-2 h-px w-6 bg-line" />
              ) : (
                <div className="mb-1.5 flex items-center gap-2 px-2.5">
                  <span className="whitespace-nowrap text-[11px] font-semibold tracking-wide text-content-subtle">
                    {t(section.title)}
                  </span>
                  {section.settings && (
                    <button
                      type="button"
                      onClick={() => onScreen(section.settings!.screen)}
                      title={t(section.settings.title)}
                      aria-label={t(section.settings.title)}
                      className={cx(
                        'ml-auto grid size-5 place-items-center rounded-md text-[12px] transition',
                        screen === section.settings.screen
                          ? 'bg-accent/20 text-accent-content'
                          : 'text-content-subtle hover:bg-surface-3 hover:text-content',
                      )}
                    >
                      ⚙
                    </button>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-0.5">
                {collapsed && section.settings && (
                  <button
                    type="button"
                    onClick={() => onScreen(section.settings!.screen)}
                    title={t(section.settings.title)}
                    className={cx(
                      'flex w-full items-center justify-center rounded-lg py-1.5 transition',
                      screen === section.settings.screen ? 'bg-accent/12' : 'hover:bg-surface-3',
                    )}
                  >
                    <span
                      className={cx(
                        'grid size-7 place-items-center rounded-md text-[13px]',
                        screen === section.settings.screen
                          ? 'bg-accent/20 text-accent-content'
                          : 'bg-surface-2 text-content-subtle',
                      )}
                    >
                      ⚙
                    </span>
                  </button>
                )}
                {section.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    disabled={item.disabled}
                    onClick={() => onScreen(item.id)}
                    title={collapsed ? t(item.label) : undefined}
                    className={cx(
                      'flex w-full items-center gap-2.5 rounded-lg py-1.5 text-left transition',
                      collapsed ? 'justify-center px-0' : 'px-2.5',
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
                    {!collapsed && (
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{t(item.label)}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {!collapsed && (
          <div className="mt-auto flex flex-col gap-2.5 px-4 py-4">
            <div className="flex items-center justify-between gap-2">
              <span className="whitespace-nowrap text-[11px] text-content-subtle">{t('settings.theme')}</span>
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
              <span className="whitespace-nowrap text-[11px] text-content-subtle">{t('settings.language')}</span>
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
        )}
      </div>
    </aside>
  )
}

function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden>
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
