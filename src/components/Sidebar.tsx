import { ArrowsLeftRight, CaretLeft, CaretRight, CircleHalf, Crosshair, Cube, FingerprintSimple, FlowArrow, Gear, GithubLogo, ListDashes, Moon, Queue, SlidersHorizontal, SquaresFour, Stack, Sun, type Icon } from '@phosphor-icons/react'

import { LANGUAGES, useI18n, type MessageKey } from '../i18n'
import { openRepository, REPOSITORY_URL } from '../lib/api'
import type { ThemeMode } from '../lib/theme'
import type { AppInfo } from '../types'
import { cx } from './ui'

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
  items: Array<{ id: ScreenId; label: MessageKey; icon: Icon; disabled?: boolean }>
}

const SECTIONS: Section[] = [
  {
    title: 'nav.files',
    items: [
      { id: 'files.trace', label: 'nav.files.trace', icon: Crosshair },
      { id: 'files.links', label: 'nav.files.links', icon: ArrowsLeftRight },
    ],
  },
  {
    title: 'nav.api',
    settings: { screen: 'api.connection', title: 'nav.api.connection.title' },
    items: [
      { id: 'api.map', label: 'nav.api.map', icon: SquaresFour },
      { id: 'api.domains', label: 'nav.api.domains', icon: Stack },
      { id: 'api.routes', label: 'nav.api.routes', icon: FlowArrow },
      { id: 'api.queues', label: 'nav.api.queues', icon: Queue },
      { id: 'api.modules', label: 'nav.api.modules', icon: Cube },
      { id: 'api.properties', label: 'nav.api.properties', icon: SlidersHorizontal },
      { id: 'api.logs', label: 'nav.api.logs', icon: ListDashes },
      // Щит для аудита — штамп; отпечаток точнее: аудит отвечает «кто это сделал».
      { id: 'api.audit', label: 'nav.api.audit', icon: FingerprintSimple },
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
            className="grid size-6 shrink-0 place-items-center rounded-md text-content-subtle transition hover:bg-surface-3 hover:text-content"
          >
            {collapsed ? <CaretRight size={13} weight="bold" /> : <CaretLeft size={13} weight="bold" />}
          </button>
        </div>

        <nav className={cx('flex min-h-0 flex-1 flex-col overflow-y-auto', collapsed ? 'gap-2 px-2' : 'gap-5 px-2')}>
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
                        'ml-auto grid size-7 place-items-center rounded-md transition',
                        screen === section.settings.screen
                          ? 'bg-accent/20 text-accent-content'
                          : 'text-content-subtle hover:bg-surface-3 hover:text-content',
                      )}
                    >
                      <Gear size={16} weight="regular" />
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
                        'grid size-7 place-items-center rounded-md',
                        screen === section.settings.screen
                          ? 'bg-accent/20 text-accent-content'
                          : 'bg-surface-2 text-content-subtle',
                      )}
                    >
                      <Gear size={16} weight="regular" />
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
                      <item.icon size={16} weight="regular" />
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

        {/*
          Тема, язык и ссылка на репозиторий — по одной кнопке на каждое.
          Кнопки остаются и в узком режиме: сворачивают панель как раз тогда,
          когда нужно место под таблицу, а тему при этом переключают не реже.
        */}
        <div className={cx('flex shrink-0 gap-1 pt-3', collapsed ? 'flex-col items-center px-2 pb-4' : 'items-center px-4 pb-2')}>
          <FooterButton
            icon={THEME_ICON[themeMode]}
            label={t(THEME_LABEL[themeMode])}
            onClick={() => onThemeMode(NEXT_THEME[themeMode])}
          />
          <FooterButton
            text={language.toUpperCase()}
            label={LANGUAGES.find((item) => item.id !== language)?.label ?? ''}
            onClick={() => setLanguage(LANGUAGES.find((item) => item.id !== language)?.id ?? language)}
          />
          <FooterButton
            icon={GithubLogo}
            label={`${t('settings.repository')} · ${REPOSITORY_URL}`}
            onClick={() => void openRepository()}
            className={collapsed ? '' : 'ml-auto'}
          />
        </div>

        {!collapsed && (
          <div className="px-4 pb-4 text-[10.5px] leading-relaxed text-content-subtle">
            {info ? `v${info.version} · Tauri ${info.tauri} · ${info.platform}` : '—'}
          </div>
        )}
      </div>
    </aside>
  )
}

/** Тема переключается по кругу, и кнопка показывает то положение, в котором стоит. */
const NEXT_THEME: Record<ThemeMode, ThemeMode> = { system: 'light', light: 'dark', dark: 'system' }
const THEME_ICON: Record<ThemeMode, Icon> = { system: CircleHalf, light: Sun, dark: Moon }
const THEME_LABEL: Record<ThemeMode, MessageKey> = {
  system: 'settings.theme.system',
  light: 'settings.theme.light',
  dark: 'settings.theme.dark',
}

/** Кнопка в подвале панели: значок или пара букв, одного размера с иконками разделов. */
function FooterButton({ icon: Glyph, text, label, onClick, className }: {
  icon?: Icon
  text?: string
  label: string
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cx(
        'grid size-8 shrink-0 place-items-center rounded-lg text-content-subtle transition',
        'hover:bg-surface-3 hover:text-content',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
        className,
      )}
    >
      {Glyph ? <Glyph size={17} weight="regular" /> : <span className="font-mono text-[11px] font-semibold">{text}</span>}
    </button>
  )
}

/**
 * Знак FESB Toolkit: «F», она же маршрут.
 *
 * Снизу — исток, дальше ствол вверх и две ветки вправо: ровно то, что
 * делает СОПС. Геометрия здесь та же, что в `public/favicon.svg` и в иконке
 * приложения, — знак должен быть везде одинаковым, поэтому меняется он
 * во всех трёх местах сразу.
 */
function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden>
      <rect width="32" height="32" rx="7.5" className="fill-surface-3" />
      <g className="stroke-accent" fill="none" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9.5 23.5V7.5H20.5" />
        <path d="M9.5 15H17.5" />
      </g>
      <g className="fill-accent">
        <circle cx="21.5" cy="7.5" r="3" />
        <circle cx="18.5" cy="15" r="3" />
        <circle cx="9.5" cy="23.5" r="3" />
      </g>
    </svg>
  )
}
