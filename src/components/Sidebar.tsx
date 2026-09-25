import { FolderOpen, FolderSimple, ArrowsLeftRight, Broadcast, CaretDown, CaretLeft, PaperPlaneTilt, CaretRight, Certificate, CircleHalf, Crosshair, CrosshairSimple, Cube, FingerprintSimple, FloppyDisk, FlowArrow, Key, GithubLogo, House, ListDashes, Moon, Plugs, PlugsConnected, Queue, SlidersHorizontal, Stack, Sun, Tray, ChartBar, ClockCounterClockwise, UsersThree, Binoculars, Terminal, type Icon } from '@phosphor-icons/react'

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
  | 'api.mqConfig'
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

/**
 * Экраны API разложены по двум папкам внутри раздела. В «Общем» — то, с чем живут на стенде каждый
 * день: домены, схемы, очереди, журналы. В «Точечных задачах» — экраны под
 * одну конкретную работу: сверить стенды, проверить сроки сертификатов,
 * включить трассировку. Четырнадцать пунктов одним списком читались как
 * стена, и редкие задачи терялись среди ежедневных.
 */
export const API_GENERAL_SCREENS: ScreenEntry[] = [
  { id: 'api.access', label: 'nav.api.access', hint: 'welcome.hint.access', icon: Key },
  // Щит для аудита — штамп; отпечаток точнее: аудит отвечает «кто это сделал».
  { id: 'api.audit', label: 'nav.api.audit', hint: 'welcome.hint.audit', icon: FingerprintSimple },
  { id: 'api.domains', label: 'nav.api.domains', hint: 'welcome.hint.domains', icon: Stack },
  { id: 'api.inflight', label: 'nav.api.inflight', hint: 'welcome.hint.inflight', icon: Broadcast },
  { id: 'api.logs', label: 'nav.api.logs', hint: 'welcome.hint.logs', icon: ListDashes },
  { id: 'api.modules', label: 'nav.api.modules', hint: 'welcome.hint.modules', icon: Cube },
  { id: 'api.properties', label: 'nav.api.properties', hint: 'welcome.hint.properties', icon: SlidersHorizontal },
  { id: 'api.queues', label: 'nav.api.queues', hint: 'welcome.hint.queues', icon: Queue },
  { id: 'api.routes', label: 'nav.api.routes', hint: 'welcome.hint.routes', icon: FlowArrow },
]

export const API_TASK_SCREENS: ScreenEntry[] = [
  { id: 'api.certificates', label: 'nav.api.certificates', hint: 'welcome.hint.certificates', icon: Certificate },
  { id: 'api.compare', label: 'nav.api.compare', title: 'nav.api.compare.title', hint: 'welcome.hint.compare', icon: ArrowsLeftRight },
  { id: 'api.endpoints', label: 'nav.api.endpoints', title: 'nav.api.endpoints.title', hint: 'welcome.hint.endpoints', icon: Plugs },
  { id: 'api.mqConfig', label: 'nav.api.mqConfig', title: 'nav.api.mqConfig.title', hint: 'welcome.hint.mqConfig', icon: FloppyDisk },
  { id: 'api.tracing', label: 'nav.api.tracing', title: 'nav.api.tracing.title', hint: 'welcome.hint.tracing', icon: CrosshairSimple },
]

/** Папки внутри раздела API — одни и те же в панели, на «Начале» и в палитре команд. */
export const API_GROUPS: Array<{ title: MessageKey; items: ScreenEntry[] }> = [
  { title: 'nav.api.general', items: API_GENERAL_SCREENS },
  { title: 'nav.api.tasks', items: API_TASK_SCREENS },
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
 * Пункты внутри папок API — по алфавиту, и алфавит здесь зависит от языка:
 * по-русски первым идёт «Аудит», по-английски — «Access». Поэтому порядок считается
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
  /** Папки внутри раздела — вместо плоского списка `items`. */
  groups?: Array<{ title: MessageKey; items: ScreenEntry[] }>
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
    items: [],
    groups: API_GROUPS,
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

  const renderItem = (item: ScreenEntry) => (
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
  )

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
                <FolderToggle
                  label={t(section.title)}
                  folded={folded.has(section.title)}
                  onToggle={() => toggleSection(section.title)}
                />
              )}

              <div className={cx('flex flex-col gap-0.5', !collapsed && folded.has(section.title) && 'hidden')}>
                {section.groups
                  ? section.groups.map((group) => (
                    <div key={group.title}>
                      {collapsed ? (
                        // В узкой панели папка — короткий штрих между группами значков.
                        <div className="mx-auto my-1 h-px w-3 bg-line" />
                      ) : (
                        <FolderRow
                          label={t(group.title)}
                          folded={folded.has(group.title)}
                          onToggle={() => toggleSection(group.title)}
                        />
                      )}
                      {/* Линия идёт от середины значка папки: видно, что пункты
                          вложены в неё, а не стоят наравне с ней. */}
                      <div
                        className={cx(
                          'flex flex-col gap-0.5',
                          !collapsed && 'ml-6 mt-0.5 border-l border-line pl-2',
                          !collapsed && folded.has(group.title) && 'hidden',
                        )}
                      >
                        {sortByLabel(group.items, (item) => t(item.label), language).map(renderItem)}
                      </div>
                    </div>
                  ))
                  : (section.sorted ? sortByLabel(section.items, (item) => t(item.label), language) : section.items).map(renderItem)}
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

/**
 * Заголовок раздела — кнопка: он и подписывает раздел, и сворачивает его.
 * Мелкий капс с разрядкой — отдельный уровень, который не спутать ни с
 * пунктом, ни с папкой: в свёрнутом виде все три иначе читались одной
 * строкой одинаковых подписей.
 */
function FolderToggle({ label, folded, onToggle }: {
  label: string
  folded: boolean
  onToggle: () => void
}) {
  return (
    <div className="mb-1.5 flex items-center px-2.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!folded}
        className={cx(
          '-ml-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 transition',
          'text-content-subtle hover:text-content',
          FOCUS_RING,
        )}
      >
        <CaretDown
          size={10}
          weight="bold"
          className={cx('shrink-0 transition-transform', folded && '-rotate-90')}
        />
        <span className="whitespace-nowrap text-[10.5px] font-semibold uppercase tracking-[0.08em]">
          {label}
        </span>
      </button>
    </div>
  )
}

/**
 * Папка внутри раздела — строка того же вида, что и пункт меню: значок в
 * плашке и подпись того же размера. Так она читается как часть раздела, а
 * не как ещё один раздел; стрелка справа показывает, раскрыта ли папка.
 */
function FolderRow({ label, folded, onToggle }: {
  label: string
  folded: boolean
  onToggle: () => void
}) {
  const Glyph = folded ? FolderSimple : FolderOpen
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!folded}
      className={cx(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-content-muted transition hover:bg-surface-3',
        FOCUS_RING,
      )}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface-2 text-content-subtle">
        <Glyph size={16} weight="regular" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{label}</span>
      <CaretRight
        size={11}
        weight="bold"
        className={cx('shrink-0 text-content-subtle transition-transform', !folded && 'rotate-90')}
      />
    </button>
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
