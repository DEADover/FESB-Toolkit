import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'

import { CaretDown, CaretLeft, CaretRight, CaretUp, Check, MagnifyingGlass, X, type Icon } from '@phosphor-icons/react'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/**
 * Кольцо фокуса с клавиатуры.
 *
 * Одно на все органы управления: до этого оно было у трёх из семи, и по Tab
 * половина интерфейса шла вслепую. Отступ в один пиксель — чтобы кольцо
 * не наезжало на соседей в плотных рядах.
 */
export const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent'

/** Единая высота органов управления в рядах фильтров: поля, списки, кнопки. */
export const CONTROL_HEIGHT = 'h-9'

type ButtonProps = ComponentProps<'button'> & {
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md'
}

export function Button({ variant = 'secondary', size = 'md', className, ...rest }: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition ' +
    'disabled:cursor-not-allowed disabled:opacity-40 ' + FOCUS_RING
  const sizes = { sm: 'h-7 px-2.5 text-[12px]', md: cx(CONTROL_HEIGHT, 'px-3.5 text-[13px]') }
  const variants = {
    primary: 'bg-accent-strong text-white hover:bg-accent shadow-sm shadow-accent-strong/25',
    secondary: 'border border-line-strong bg-surface-2 text-content hover:bg-surface-3',
    ghost: 'text-content-muted hover:bg-surface-3 hover:text-content',
  }
  return <button type="button" className={cx(base, sizes[size], variants[variant], className)} {...rest} />
}

/**
 * Кнопка-иконка для действий в строке таблицы.
 *
 * Подписи вроде «Перезапустить» съедают половину строки и в русском языке
 * заметно шире английских — на трёх действиях это уже целая колонка.
 * Значение при этом остаётся в подсказке и в имени для экранного диктора.
 */
export function IconButton({ icon: Glyph, label, busy, disabled, tone, size = 'sm', onClick }: {
  icon: Icon
  label: string
  busy?: boolean
  disabled?: boolean
  tone?: 'danger'
  /**
   * `sm` — для строк таблицы, `md` — для рядов фильтров.
   *
   * Иконка в 28 пикселей рядом с полем в 36 бросается в глаза: в ряду
   * органы управления должны быть одной высоты, а в строке таблицы —
   * наоборот, как можно ниже.
   */
  size?: 'sm' | 'md'
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      title={label}
      aria-label={label}
      className={cx(
        'grid shrink-0 place-items-center border border-line-strong bg-surface-2 transition',
        size === 'md' ? cx(CONTROL_HEIGHT, 'w-9 rounded-lg') : 'size-7 rounded-md',
        'hover:bg-surface-3 hover:text-content disabled:cursor-not-allowed disabled:opacity-35',
        FOCUS_RING,
        tone === 'danger' ? 'text-negative' : 'text-content-muted',
      )}
    >
      {busy ? <Spinner className="size-3.5" /> : <Glyph size={size === 'md' ? 16 : 15} weight="bold" />}
    </button>
  )
}

export type Tone = 'neutral' | 'accent' | 'warn' | 'danger' | 'ok'

/** Один набор цветов на все капсулы: и на подписи, и на коды в таблицах. */
export const TONES: Record<Tone, string> = {
  neutral: 'border-line-strong bg-surface-3 text-content-muted',
  accent: 'border-accent/35 bg-accent/12 text-accent-content',
  ok: 'border-positive/35 bg-positive/12 text-positive',
  warn: 'border-caution/35 bg-caution/12 text-caution',
  danger: 'border-negative/35 bg-negative/12 text-negative',
}

export function Badge({ children, tone = 'neutral', className, title }: {
  children: ReactNode
  tone?: Tone
  className?: string
  title?: string
}) {
  return (
    <span
      title={title}
      className={cx('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none', TONES[tone], className)}
    >
      {children}
    </span>
  )
}

/**
 * Капсула с машинным значением: уровень записи, код ответа.
 *
 * Отдельная от `Badge` — здесь моноширинный шрифт, потому что значение
 * читают как код, а не как подпись. Общая, чтобы в журналах и в аудите
 * такие капсулы были одного размера: одна с рамкой, другая без неё
 * различались на два пикселя, и это было видно.
 */
export function CodePill({ children, tone = 'neutral', title }: {
  children: ReactNode
  tone?: Tone
  title?: string
}) {
  return (
    <span
      title={title}
      className={cx('inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10.5px] leading-none', TONES[tone])}
    >
      {children}
    </span>
  )
}

export function Checkbox({ className, ...rest }: ComponentProps<'input'>) {
  return (
    <input
      type="checkbox"
      className={cx(
        'size-[15px] shrink-0 cursor-pointer appearance-none rounded-[4px] border border-line-strong bg-surface',
        'checked:border-accent checked:bg-accent-strong',
        "checked:after:block checked:after:h-full checked:after:w-full checked:after:bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22 fill=%22white%22><path d=%22M6.2 11.9 2.9 8.6l1.3-1.3 2 2 5-5 1.3 1.3z%22/></svg>')] checked:after:bg-contain",
        'indeterminate:border-accent indeterminate:bg-accent-strong',
        "indeterminate:after:block indeterminate:after:h-full indeterminate:after:w-full indeterminate:after:bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22 fill=%22white%22><rect x=%224%22 y=%227%22 width=%228%22 height=%222%22 rx=%221%22/></svg>')] indeterminate:after:bg-contain",
        'disabled:cursor-not-allowed disabled:opacity-40',
        FOCUS_RING,
        className,
      )}
      {...rest}
    />
  )
}

/**
 * Поле поиска: то же `TextInput`, но с лупой внутри.
 *
 * Эта пара — поле плюс значок в абсолютной позиции — была скопирована
 * на восьми экранах. Один компонент дешевле, и лупа теперь везде одна и та же.
 */
export function SearchInput({ value, placeholder, onChange, className, inputRef, clearLabel }: {
  value: string
  placeholder: string
  onChange: (value: string) => void
  className?: string
  inputRef?: React.Ref<HTMLInputElement>
  /** Задан — справа появляется крестик, который стирает запрос. */
  clearLabel?: string
}) {
  return (
    // Ширину задаёт тот, кто ставит поле: в ряду оно растягивается, в колонке нет.
    <div className={cx('relative min-w-0', className)}>
      <TextInput
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        className={cx('pl-8', clearLabel && value && 'pr-8')}
        onChange={(event) => onChange(event.target.value)}
      />
      <MagnifyingGlass
        size={14}
        weight="bold"
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle"
      />
      {clearLabel && value && (
        <button
          type="button"
          aria-label={clearLabel}
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1 text-content-subtle transition hover:text-content"
        >
          <X size={13} weight="bold" />
        </button>
      )}
    </div>
  )
}

/**
 * Обработчик клика по строке, который не мешает выделять текст.
 *
 * Строки журналов, аудита и связей разворачиваются по клику. Стоит выделить
 * в такой строке guid — и на отпускании кнопки строка схлопывается вместе
 * с выделением. Поэтому клик после протяжки мы пропускаем.
 */
export function rowClick(action: (event: React.MouseEvent) => void) {
  return (event: React.MouseEvent) => {
    // Клик по кнопке внутри строки обрабатывает сама кнопка.
    if ((event.target as HTMLElement).closest('button, a, input, select')) return
    // Двойной и тройной клик — это выделение слова и строки, а не «разверни».
    if (event.detail > 1) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed && selection.toString().trim().length > 0) return
    action(event)
  }
}

/**
 * Закрывает всплывающую панель по клику мимо неё и по Escape.
 *
 * Один обработчик на все выпадающие списки: у каждого свой был бы шансом
 * забыть Escape.
 */
export function useClickAway(ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close()
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [ref, close])
}

/**
 * Одиночный выбор.
 *
 * Свой список, а не `<select>`: нативный раскрывается системным меню
 * в светлом оформлении — на тёмной теме это выглядело чужой заплатой,
 * да и рядом с `MultiSelect` два разных списка бросались в глаза.
 */
export function Select<T extends string | number>({ value, options, onChange, ariaLabel, label, className }: {
  value: T
  options: Array<{ id: T; label: string }>
  onChange: (value: T) => void
  ariaLabel: string
  /** Подпись слева от значения — как у `MultiSelect`. */
  label?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const holder = useRef<HTMLDivElement>(null)
  useClickAway(holder, () => setOpen(false))

  const current = options.find((option) => option.id === value)

  return (
    <div ref={holder} className={cx('relative shrink-0', className)}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
        className={cx(
          CONTROL_HEIGHT,
          'flex w-full items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 text-[12.5px] transition',
          'hover:border-content-subtle',
          FOCUS_RING,
        )}
      >
        {label && <span className="shrink-0 text-content-subtle">{label}</span>}
        <span className="min-w-0 flex-1 truncate text-left font-medium text-content">
          {current?.label ?? ''}
        </span>
        <CaretDown size={10} weight="bold" className="shrink-0 text-content-subtle" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full z-40 mt-1 max-h-72 w-full min-w-40 overflow-y-auto rounded-xl border border-line-strong bg-surface p-1.5 shadow-2xl"
        >
          {options.map((option) => (
            <button
              key={String(option.id)}
              type="button"
              role="option"
              aria-selected={option.id === value}
              onClick={() => { onChange(option.id); setOpen(false) }}
              className={cx(
                'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition',
                option.id === value ? 'bg-accent/12 text-content' : 'text-content-muted hover:bg-surface-3',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.id === value && <Check size={12} weight="bold" className="shrink-0 text-accent-content" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Выбор нескольких значений списком.
 *
 * Уровни журнала и сами файлы журналов раньше лежали рядом кнопок: на десяти
 * файлах ряд переставал помещаться и уезжал под горизонтальную прокрутку.
 * Список занимает одну кнопку и показывает, сколько выбрано.
 */
export function MultiSelect({ label, options, selected, onChange, className, emptyLabel }: {
  label: string
  options: Array<{ id: string; label: string; hint?: string; tone?: Tone }>
  selected: Set<string>
  onChange: (selected: Set<string>) => void
  className?: string
  /** Что показать, когда не выбрано ничего. */
  emptyLabel: string
}) {
  const [open, setOpen] = useState(false)
  const holder = useRef<HTMLDivElement>(null)
  useClickAway(holder, () => setOpen(false))

  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next)
  }

  const chosen = options.filter((option) => selected.has(option.id))
  const summary = chosen.length === 0
    ? emptyLabel
    : chosen.length <= 2
      ? chosen.map((option) => option.label).join(', ')
      : `${chosen.length}`

  return (
    <div ref={holder} className={cx('relative shrink-0', className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title={label}
        className={cx(
          CONTROL_HEIGHT,
          'flex w-full items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 text-[12.5px] transition',
          'hover:border-content-subtle',
          FOCUS_RING,
          chosen.length ? 'text-content' : 'text-content-subtle',
        )}
      >
        <span className="shrink-0 text-content-subtle">{label}</span>
        <span className="min-w-0 flex-1 truncate text-left font-medium">{summary}</span>
        <CaretDown size={10} weight="bold" className="shrink-0 text-content-subtle" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 max-h-72 w-64 overflow-y-auto rounded-xl border border-line-strong bg-surface p-1.5 shadow-2xl">
          {options.map((option) => (
            <label
              key={option.id}
              title={option.hint}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] transition hover:bg-surface-3"
            >
              <Checkbox checked={selected.has(option.id)} onChange={() => toggle(option.id)} />
              <span className={cx('min-w-0 flex-1 truncate', option.tone && TONES[option.tone].split(' ').pop())}>
                {option.label}
              </span>
              {option.hint && <span className="shrink-0 text-[10.5px] text-content-subtle">{option.hint}</span>}
            </label>
          ))}
          {options.length === 0 && (
            <p className="px-2 py-4 text-center text-[11.5px] text-content-subtle">{emptyLabel}</p>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Пустая страница: значок, заголовок, пояснение и, если есть куда, кнопка.
 *
 * Лежала пятью копиями с разъехавшимися отступами — на экране подключений
 * пояснение было на полпункта мельче остальных, и это было заметно.
 */
export function EmptyState({ icon: Glyph, title, text, action, children }: {
  icon: Icon
  title: string
  text?: string
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 pb-10">
      <div className="max-w-md text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-surface-2 text-accent-content">
          <Glyph size={24} weight="regular" />
        </div>
        <h2 className="mt-4 text-[15px] font-semibold">{title}</h2>
        {text && <p className="mt-2 text-[12.5px] leading-relaxed text-content-subtle">{text}</p>}
        {children}
        {action && <div className="mt-5">{action}</div>}
      </div>
    </div>
  )
}

/**
 * Полоса-уведомление: ошибка, предупреждение, подтверждение.
 *
 * Лежала восемнадцатью копиями с разной прозрачностью рамки (/40 против /35)
 * и разным кеглем. Отступы снаружи задаёт тот, кто ставит полосу: она
 * встречается и в потоке экрана, и внутри панели с собственными полями.
 */
export function Notice({ tone, small, className, children }: {
  tone: 'danger' | 'warn' | 'ok'
  small?: boolean
  className?: string
  children: ReactNode
}) {
  const tones = {
    danger: 'border-negative/35 bg-negative/10 text-negative',
    warn: 'border-caution/35 bg-caution/10 text-caution',
    ok: 'border-positive/35 bg-positive/10 text-positive',
  }
  return (
    <div className={cx('rounded-lg border px-3 py-2', small && 'text-[11.5px]', tones[tone], className)}>
      {children}
    </div>
  )
}

/**
 * Переключатель-пилюля: чекбокс с подписью в рамке высотой с поле ввода.
 *
 * Лежал шестью копиями — «только активные», «только проблемные», «скрыть
 * служебные», автообновление и так далее. Подпись не переносится: ряд
 * с фильтрами скорее сожмёт поле поиска, чем сломает подпись пополам.
 */
export function Toggle({ checked, onChange, label, disabled, title }: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  disabled?: boolean
  title?: string
}) {
  return (
    <label
      title={title}
      className={cx(
        CONTROL_HEIGHT,
        'flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-line-strong',
        'bg-surface px-3 text-[12.5px] text-content-muted',
        'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-accent',
        disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
      )}
    >
      <Checkbox checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  )
}

export function TextInput({ className, ...rest }: ComponentProps<'input'> & { ref?: React.Ref<HTMLInputElement> }) {
  return (
    <input
      className={cx(
        CONTROL_HEIGHT,
        'w-full rounded-lg border border-line-strong bg-surface px-3 text-content outline-none transition',
        'hover:border-content-subtle focus:border-accent focus:ring-2 focus:ring-accent/25',
        className,
      )}
      {...rest}
    />
  )
}

/** Компактный переключатель на два-три положения (тема, язык). */
export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T
  options: Array<{ id: T; label: string; title?: string }>
  onChange: (value: T) => void
  ariaLabel: string
}) {
  return (
    // Высота как у полей рядом: переключатель стоит в тех же рядах фильтров.
    <div
      role="group"
      aria-label={ariaLabel}
      className={cx(CONTROL_HEIGHT, 'inline-flex shrink-0 items-center rounded-lg border border-line-strong bg-surface-2 p-0.5')}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          title={option.title ?? option.label}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={cx(
            'rounded-[6px] px-2 py-1 text-[11.5px] font-medium transition',
            FOCUS_RING,
            value === option.id ? 'bg-accent-strong text-white' : 'text-content-muted hover:text-content',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Поле ввода с подсказками из уже встречающихся значений.
 *
 * Нативный `datalist` не годится: он обрезается краем окна. Свой список
 * прокручивается, управляется с клавиатуры и сам выбирает сторону — вниз,
 * если под полем есть место, и вверх, если поле прижато к низу окна.
 */
/** Высота раскрытого списка: по ней решается, хватает ли места снизу. */
const LIST_HEIGHT = 232

export function SuggestInput({ id, value, options, placeholder, onChange, emptyLabel }: {
  id: string
  value: string
  options: string[]
  placeholder?: string
  onChange: (value: string) => void
  emptyLabel: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [dropUp, setDropUp] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)

  /** Сторона выбирается по свободному месту, а не назначается заранее. */
  const chooseSide = () => {
    const box = wrapper.current?.getBoundingClientRect()
    if (!box) return
    const below = window.innerHeight - box.bottom
    setDropUp(below < LIST_HEIGHT && box.top > below)
  }

  const matches = useMemo(() => {
    const needle = value.trim().toLowerCase()
    const list = needle ? options.filter((option) => option.toLowerCase().includes(needle)) : options
    return list.slice(0, 100)
  }, [options, value])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const choose = (option: string) => {
    onChange(option)
    setOpen(false)
    setActive(-1)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        chooseSide()
        setOpen(true)
        setActive(0)
        return
      }
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((prev) => Math.min(Math.max(prev + step, 0), matches.length - 1))
      return
    }
    if (event.key === 'Enter' && open && active >= 0 && matches[active]) {
      event.preventDefault()
      choose(matches[active])
    }
  }

  return (
    <div ref={wrapper} className="relative">
      <TextInput
        id={id}
        value={value}
        placeholder={placeholder}
        className="font-mono"
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        onChange={(event) => {
          onChange(event.target.value)
          chooseSide()
          setOpen(true)
          setActive(-1)
        }}
        onFocus={() => { chooseSide(); setOpen(true) }}
        onKeyDown={onKeyDown}
      />

      {open && (
        <div
          className={cx(
            'absolute left-0 right-0 z-30 max-h-56 overflow-auto rounded-lg border border-line-strong bg-surface py-1 shadow-2xl',
            dropUp ? 'bottom-full mb-1' : 'top-full mt-1',
          )}
        >
          {matches.length === 0 ? (
            <div className="px-3 py-1.5 text-[11.5px] text-content-subtle">{emptyLabel}</div>
          ) : (
            matches.map((option, index) => (
              <button
                key={option}
                type="button"
                // mousedown, а не click: иначе поле успевает потерять фокус и список закрывается.
                onMouseDown={(event) => { event.preventDefault(); choose(option) }}
                onMouseEnter={() => setActive(index)}
                className={cx(
                  'block w-full px-3 py-1 text-left font-mono text-[12px]',
                  index === active ? 'bg-accent/15 text-accent-content' : 'text-content-muted',
                  option === value && 'font-semibold text-content',
                )}
              >
                {option}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Горизонтальная полоса, которая не переносится на вторую строку, а прокручивается.
 * Градиентные края появляются только с той стороны, где содержимое реально
 * уходит за границу, — иначе они бы зря приглушали крайние элементы.
 */
export function ScrollStrip({ children, className, itemCount, scrollLeftLabel, scrollRightLabel }: {
  children: ReactNode
  className?: string
  /** Пересчитать края, когда содержимое сменилось. */
  itemCount?: number
  scrollLeftLabel: string
  scrollRightLabel: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ start: false, end: false })

  useEffect(() => {
    const element = ref.current
    if (!element) return

    const update = () => setEdges({
      start: element.scrollLeft > 1,
      end: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
    })

    update()
    element.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => {
      element.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [itemCount])

  const scrollBy = (direction: -1 | 1) => {
    const element = ref.current
    if (element) element.scrollBy({ left: direction * Math.max(element.clientWidth * 0.7, 160), behavior: 'smooth' })
  }

  return (
    <div className={cx('relative min-w-0', className)}>
      <div
        ref={ref}
        className="flex flex-nowrap items-center gap-1.5 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>

      {edges.start && (
        <ScrollEdge side="start" label={scrollLeftLabel} onClick={() => scrollBy(-1)} />
      )}
      {edges.end && (
        <ScrollEdge side="end" label={scrollRightLabel} onClick={() => scrollBy(1)} />
      )}
    </div>
  )
}

/** Градиент с кнопкой: сразу видно, что содержимое продолжается, и куда листать. */
function ScrollEdge({ side, label, onClick }: { side: 'start' | 'end'; label: string; onClick: () => void }) {
  const isStart = side === 'start'
  return (
    <div
      className={cx(
        'absolute inset-y-0 flex w-14 items-center',
        isStart
          ? 'left-0 justify-start bg-gradient-to-r from-surface via-surface/85 to-transparent'
          : 'right-0 justify-end bg-gradient-to-l from-surface via-surface/85 to-transparent',
      )}
    >
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={onClick}
        className="grid size-6 place-items-center rounded-md border border-line-strong bg-surface-2 text-content-muted shadow-sm transition hover:bg-surface-3 hover:text-content"
      >
        {isStart ? <CaretLeft size={12} weight="bold" /> : <CaretRight size={12} weight="bold" />}
      </button>
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx('animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

export function Modal({ open, onClose, title, children, footer, wide, closeLabel }: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  closeLabel: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        className={cx('flex max-h-[85vh] w-full flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-2xl', wide ? 'max-w-4xl' : 'max-w-lg')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label={closeLabel}><X size={14} weight="bold" /></Button>
        </div>
        <div className="flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}

export function Stat({ label, value, tone, hint }: {
  label: string
  value: ReactNode
  tone?: 'accent' | 'warn' | 'danger'
  hint?: string
}) {
  const color = tone === 'accent' ? 'text-accent-content' : tone === 'warn' ? 'text-caution' : tone === 'danger' ? 'text-negative' : 'text-content'
  return (
    <div className="flex shrink-0 flex-col gap-0.5" title={hint}>
      <span className={cx('text-[17px] font-semibold leading-none tabular-nums', color)}>{value}</span>
      <span className={cx('whitespace-nowrap text-[11px] tracking-wide text-content-subtle', hint && 'decoration-dotted underline-offset-2 hover:underline')}>{label}</span>
    </div>
  )
}

/**
 * Таблица данных: оболочка, шапка и ячейка заголовка.
 *
 * Одни и те же три строки классов лежали в десяти экранах, а `<th>` — в
 * тридцати восьми местах. Правка кегля или отступов означала обход всех.
 * Теперь это одно место, и `colgroup` каждый экран задаёт себе сам —
 * ширины у всех разные и общими быть не могут.
 */
export function DataTable({ dense, children }: { dense?: boolean; children: ReactNode }) {
  return (
    <table className={cx('w-full table-fixed border-collapse', dense ? 'text-[11.5px]' : 'text-[12.5px]')}>
      {children}
    </table>
  )
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="sticky top-0 z-10 bg-surface-2 text-[11px] tracking-wide text-content-subtle">
      <tr className="border-b border-line">{children}</tr>
    </thead>
  )
}

export function Th({ align = 'left', className, title, children }: {
  align?: 'left' | 'right'
  className?: string
  title?: string
  children?: ReactNode
}) {
  return (
    <th title={title} className={cx('px-3 py-2 font-medium', align === 'right' ? 'text-right' : 'text-left', className)}>
      {children}
    </th>
  )
}

/**
 * Подпись над числом.
 *
 * Отличается от `Stat` порядком: там число сверху и это сводка, здесь подпись
 * сверху и это строка показателей. Обе формы живые, поэтому обе и оставлены,
 * но копий каждой должно быть по одной.
 */
export function Readout({ label, value, tone, hint }: {
  label: string
  value: ReactNode
  tone?: 'accent' | 'warn' | 'danger'
  hint?: string
}) {
  const color = tone === 'accent' ? 'text-accent-content' : tone === 'warn' ? 'text-caution' : tone === 'danger' ? 'text-negative' : ''
  return (
    <div title={hint}>
      <div className="text-[11px] tracking-wide text-content-subtle">{label}</div>
      <div className={cx('text-[17px] font-semibold tabular-nums', color)}>{value}</div>
    </div>
  )
}

/** Подпись над текстом: то же, что `Readout`, но значение читают, а не считают. */
export function TextReadout({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] tracking-wide text-content-subtle">{label}</div>
      <div className="truncate text-[13px] font-medium" title={value}>{value}</div>
    </div>
  )
}

/** Ячейка заголовка таблицы с сортировкой. */
export function SortHead<K extends string>({ label, sortKey, active, dir, onSort, className }: {
  label: string
  sortKey: K
  active: K
  dir: 'asc' | 'desc'
  onSort: (key: K) => void
  className?: string
}) {
  const isActive = active === sortKey
  return (
    <th className={cx('border-b border-line px-3 py-2.5 text-left font-medium', className)}>
      <button type="button" onClick={() => onSort(sortKey)} className="inline-flex items-center gap-1 hover:text-content">
        {label}
        <span className={cx(isActive ? 'text-accent-content' : 'text-content-subtle/50')}>
          {isActive && dir === 'desc' ? <CaretDown size={10} weight="bold" /> : <CaretUp size={10} weight="bold" />}
        </span>
      </button>
    </th>
  )
}
