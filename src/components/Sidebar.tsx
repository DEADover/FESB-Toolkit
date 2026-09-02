import { ArrowsLeftRight, Broadcast, CaretDown, CaretLeft, PaperPlaneTilt, CaretRight, Certificate, CircleHalf, Crosshair, CrosshairSimple, Cube, FingerprintSimple, FlowArrow, Key, GithubLogo, House, ListDashes, Moon, Plugs, PlugsConnected, Queue, SlidersHorizontal, Stack, Sun, Tray, ChartBar, ClockCounterClockwise, UsersThree, Binoculars, Terminal, type Icon } from '@phosphor-icons/react'

import { useEffect, useState } from 'react'

import { LANGUAGES, useI18n, type MessageKey } from '../i18n'
import { openRepository, REPOSITORY_URL } from '../lib/api'
import type { ThemeMode } from '../lib/theme'
import type { AppInfo } from '../types'
import { cx, FOCUS_RING } from './ui'

export type ScreenId =
  | 'welcome'
  | 'files.trace'
  | 'files.links'
  | 'connection'
  | 'api.domains'
  | 'api.routes'
  | 'api.tracing'
  | 'api.inflight'
  | 'api.endpoints'
  | 'api.certificates'
  | 'api.compare'
  | 'api.queues'
  | 'api.modules'
  | 'api.properties'
  | 'api.logs'
  | 'api.audit'
  | 'api.access'
  | 'amqp.publisher'
  | 'amqp.subscriber'
  | 'amqp.browser'
  | 'amqp.inspector'
  | 'amqp.history'
  | 'amqp.stats'
  | 'amqp.console'

/**
 * Экран раздела: подпись, значок и пояснение для первого экрана.
 *
 * Список один на боковую панель и на «Начало»: раньше он лежал в двух
 * местах и уже расходился — новый раздел появлялся в меню и не появлялся
 * плиткой. `title` заводится только там, где короткой подписи мало:
 * «Точки» в узкой панели — это всё, что влезает, а на плитке помещается
 * «Точки Входа и Выхода».
 */
export interface ScreenEntry {
  id: ScreenId
  label: MessageKey
  /** Длинный заголовок для плитки, если короткой подписи мало. */
  title?: MessageKey
  /** Одна строка о том, зачем сюда заходят, — на первом экране. */
  hint: MessageKey
  icon: Icon
}

export const FILE_SCREENS: ScreenEntry[] = [
  { id: 'files.trace', label: 'nav.files.trace', hint: 'welcome.hint.trace', icon: Crosshair },
  { id: 'files.links', label: 'nav.files.links', title: 'nav.files.links.title', hint: 'welcome.hint.links', icon: ArrowsLeftRight },
]

export const API_SCREENS: ScreenEntry[] = [
  { id: 'api.access', label: 'nav.api.access', hint: 'welcome.hint.access', icon: Key },
  // Щит для аудита — штамп; отпечаток точнее: аудит отвечает «кто это сделал».
  { id: 'api.audit', label: 'nav.api.audit', hint: 'welcome.hint.audit', icon: FingerprintSimple },
  { id: 'api.certificates', label: 'nav.api.certificates', hint: 'welcome.hint.certificates', icon: Certificate },
  { id: 'api.compare', label: 'nav.api.compare', title: 'nav.api.compare.title', hint: 'welcome.hint.compare', icon: ArrowsLeftRight },
  { id: 'api.domains', label: 'nav.api.domains', hint: 'welcome.hint.domains', icon: Stack },
  { id: 'api.endpoints', label: 'nav.api.endpoints', title: 'nav.api.endpoints.title', hint: 'welcome.hint.endpoints', icon: Plugs },
  { id: 'api.inflight', label: 'nav.api.inflight', hint: 'welcome.hint.inflight', icon: Broadcast },
  { id: 'api.logs', label: 'nav.api.logs', hint: 'welcome.hint.logs', icon: ListDashes },
  { id: 'api.modules', label: 'nav.api.modules', hint: 'welcome.hint.modules', icon: Cube },
  { id: 'api.properties', label: 'nav.api.properties', hint: 'welcome.hint.properties', icon: SlidersHorizontal },
  { id: 'api.queues', label: 'nav.api.queues', hint: 'welcome.hint.queues', icon: Queue },
  { id: 'api.routes', label: 'nav.api.routes', hint: 'welcome.hint.routes', icon: FlowArrow },
  { id: 'api.tracing', label: 'nav.api.tracing', title: 'nav.api.tracing.title', hint: 'welcome.hint.tracing', icon: CrosshairSimple },
]

/**
 * Раздел AMQP: перенесённый целиком клиент брокеров AMQP 1.0.
 *
 * Пункт один, потому что внутри у него своя навигация вкладками —
 * восемь экранов, которые не покидают дерево при переключении, чтобы
 * живой подписчик продолжал слушать очередь.
 */
export const AMQP_SCREENS: ScreenEntry[] = [
  { id: 'amqp.publisher', label: 'nav.amqp.publisher', hint: 'welcome.hint.amqp.publisher', icon: PaperPlaneTilt },
  { id: 'amqp.subscriber', label: 'nav.amqp.subscriber', hint: 'welcome.hint.amqp.subscriber', icon: Tray },
  { id: 'amqp.browser', label: 'nav.amqp.browser', hint: 'welcome.hint.amqp.browser', icon: Binoculars },
  { id: 'amqp.inspector', label: 'nav.amqp.inspector', hint: 'welcome.hint.amqp.inspector', icon: UsersThree },
  { id: 'amqp.history', label: 'nav.amqp.history', hint: 'welcome.hint.amqp.history', icon: ClockCounterClockwise },
  { id: 'amqp.stats', label: 'nav.amqp.stats', hint: 'welcome.hint.amqp.stats', icon: ChartBar },
  { id: 'amqp.console', label: 'nav.amqp.console', hint: 'welcome.hint.amqp.console', icon: Terminal },
]

/**
 * Разделы API — по алфавиту, и алфавит здесь зависит от языка: по-русски
 * первым идёт «Аудит», по-английски — «Access». Поэтому порядок считается
 * при отрисовке по видимой подписи, а не задаётся порядком в коде.
 */
export function sortByLabel<T>(items: T[], label: (item: T) => string, language: string): T[] {
  return [...items].sort((a, b) => label(a).localeCompare(label(b), language))
}

interface Section {
  title: MessageKey
  /** Раздел без заголовка: один пункт, подписывать его дважды незачем. */
  bare?: boolean
  /** Порядок пунктов — по алфавиту текущего языка. */
  sorted?: boolean
  items: ScreenEntry[]
}

const SECTIONS: Section[] = [
  {
    // Первый экран стоит над разделами: он не про файлы и не про API,
    // он про выбор между ними. Следом — стенды: к ним возвращаются из
    // любого раздела, и шестерёнка в шапке приложения находилась хуже,
    // чем обычный пункт на своём месте в меню.
    title: 'nav.welcome',
    bare: true,
    items: [
      { id: 'welcome', label: 'nav.welcome', hint: 'nav.welcome', icon: House },
      { id: 'connection', label: 'nav.connection', hint: 'welcome.hint.connection', icon: PlugsConnected },
    ],
  },
  {
    // Здесь порядок не алфавитный, а рабочий: сначала открывают папку
    // и правят трассировку, и только потом смотрят, кто с кем связан.
    title: 'nav.files',
    items: FILE_SCREENS,
  },
  {
    title: 'nav.api',
    sorted: true,
    items: API_SCREENS,
  },
  {
    // Экраны раздела стоят наравне с остальными, а не вкладками внутри:
    // разделов в панели три, и у всех трёх одинаковые правила. Брокер —
    // часть профиля стенда и настраивается там же, в «Подключениях».
    title: 'nav.amqp',
    items: AMQP_SCREENS,
  },
]

/**
 * Свёрнутые разделы.
 *
 * Разделов три, и в каждом до дюжины экранов: тот, кто живёт в файловом
 * режиме, не хочет видеть двенадцать пунктов про API. Свёрнутость помнится
 * между запусками — заново сворачивать каждое утро незачем.
 */
const FOLDED_KEY = 'fesb.sidebar.folded'

function readFolded(): Set<MessageKey> {
  try {
    const stored = localStorage.getItem(FOLDED_KEY)
    return new Set(stored ? (JSON.parse(stored) as MessageKey[]) : [])
  } catch {
    return new Set()
  }
}

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
  const [folded, setFolded] = useState<Set<MessageKey>>(readFolded)

  useEffect(() => {
    try { localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded])) } catch { /* приватный режим */ }
  }, [folded])

  const toggleSection = (title: MessageKey) => setFolded((prev) => {
    const next = new Set(prev)
    if (next.has(title)) next.delete(title)
    else next.add(title)
    return next
  })

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
            className={cx('grid size-6 shrink-0 place-items-center rounded-md text-content-subtle transition hover:bg-surface-3 hover:text-content', FOCUS_RING)}
          >
            {collapsed ? <CaretRight size={13} weight="bold" /> : <CaretLeft size={13} weight="bold" />}
          </button>
        </div>

        <nav className={cx('flex min-h-0 flex-1 flex-col overflow-y-auto', collapsed ? 'gap-2 px-2' : 'gap-5 px-2')}>
          {SECTIONS.map((section) => (
            <div key={section.title}>
              {section.bare ? null : collapsed ? (
                // В узком режиме заголовок раздела не помещается — вместо него разделитель.
                <div className="mx-auto mb-2 h-px w-6 bg-line" />
              ) : (
                <div className="mb-1.5 flex items-center gap-1 px-2.5">
                  {/* Заголовок — кнопка: он и подписывает раздел, и сворачивает
                      его. Отдельный значок рядом с подписью занимал бы место
                      и промахивался бы мимо пальца. */}
                  <button
                    type="button"
                    onClick={() => toggleSection(section.title)}
                    aria-expanded={!folded.has(section.title)}
                    className={cx(
                      'group -ml-1 flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 transition',
                      'text-content-subtle hover:text-content',
                      FOCUS_RING,
                    )}
                  >
                    <CaretDown
                      size={11}
                      weight="bold"
                      className={cx('shrink-0 transition-transform', folded.has(section.title) && '-rotate-90')}
                    />
                    <span className="whitespace-nowrap text-[11px] font-semibold tracking-wide">
                      {t(section.title)}
                    </span>
                  </button>
                </div>
              )}

              <div className={cx('flex flex-col gap-0.5', !collapsed && folded.has(section.title) && 'hidden')}>
                {(section.sorted ? sortByLabel(section.items, (item) => t(item.label), language) : section.items).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onScreen(item.id)}
                    title={collapsed ? t(item.label) : undefined}
                    className={cx(
                      'flex w-full items-center gap-2.5 rounded-lg py-1.5 text-left transition',
                      FOCUS_RING,
                      collapsed ? 'justify-center px-0' : 'px-2.5',
                      screen === item.id ? 'bg-accent/12 text-content' : 'text-content-muted',
                      screen !== item.id && 'hover:bg-surface-3',
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
        <div className={cx('flex shrink-0 flex-col gap-1 pb-4 pt-3', collapsed ? 'items-center px-2' : 'px-4')}>
          <div className={cx('flex gap-1', collapsed ? 'flex-col items-center' : 'items-center')}>
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
          </div>

          {/* Версия читается вместе со ссылкой на репозиторий: за номером
              идут туда же, где лежат исходники. */}
          <div className={cx('flex items-center gap-1', collapsed && 'flex-col')}>
            <FooterButton
              icon={GithubLogo}
              label={`${t('settings.repository')} · ${REPOSITORY_URL}`}
              onClick={() => void openRepository()}
            />
            {!collapsed && info && (
              <span className="font-mono text-[12px] tabular-nums text-content-subtle">v{info.version}</span>
            )}
          </div>
        </div>
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
        FOCUS_RING,
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
