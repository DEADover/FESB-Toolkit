import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

type ButtonProps = ComponentProps<'button'> & {
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md'
}

export function Button({ variant = 'secondary', size = 'md', className, ...rest }: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition ' +
    'disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
  const sizes = { sm: 'h-7 px-2.5 text-[12px]', md: 'h-9 px-3.5 text-[13px]' }
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
export function IconButton({ icon, label, busy, disabled, tone, onClick }: {
  icon: string
  label: string
  busy?: boolean
  disabled?: boolean
  tone?: 'danger'
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
        'grid size-7 shrink-0 place-items-center rounded-md border border-line-strong bg-surface-2 text-[12px] transition',
        'hover:bg-surface-3 hover:text-content disabled:cursor-not-allowed disabled:opacity-35',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
        tone === 'danger' ? 'text-negative' : 'text-content-muted',
      )}
    >
      {busy ? <Spinner className="size-3.5" /> : icon}
    </button>
  )
}

export function Badge({ children, tone = 'neutral', className, title }: {
  children: ReactNode
  tone?: 'neutral' | 'accent' | 'warn' | 'danger' | 'ok'
  className?: string
  title?: string
}) {
  const tones = {
    neutral: 'border-line-strong bg-surface-3 text-content-muted',
    accent: 'border-accent/35 bg-accent/12 text-accent-content',
    ok: 'border-positive/35 bg-positive/12 text-positive',
    warn: 'border-caution/35 bg-caution/12 text-caution',
    danger: 'border-negative/35 bg-negative/12 text-negative',
  }
  return (
    <span
      title={title}
      className={cx('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none', tones[tone], className)}
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
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
        className,
      )}
      {...rest}
    />
  )
}

export function TextInput({ className, ...rest }: ComponentProps<'input'>) {
  return (
    <input
      className={cx(
        'h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-content outline-none transition',
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
    <div role="group" aria-label={ariaLabel} className="inline-flex rounded-lg border border-line-strong bg-surface-2 p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          title={option.title ?? option.label}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={cx(
            'rounded-[6px] px-2 py-1 text-[11.5px] font-medium transition',
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
        className="grid size-6 place-items-center rounded-md border border-line-strong bg-surface-2 text-[11px] text-content-muted shadow-sm transition hover:bg-surface-3 hover:text-content"
      >
        {isStart ? '‹' : '›'}
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
          <Button variant="ghost" size="sm" onClick={onClose} aria-label={closeLabel}>✕</Button>
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
        <span className={cx('text-[9px]', isActive ? 'text-accent-content' : 'text-content-subtle/50')}>
          {isActive && dir === 'desc' ? '▼' : '▲'}
        </span>
      </button>
    </th>
  )
}
