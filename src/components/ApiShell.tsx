import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { ArrowsClockwise, ArrowsLeftRight } from '@phosphor-icons/react'

import { useI18n, useRichText } from '../i18n'
import { errorText } from '../lib/api'
import type { Connection } from '../types'
import { ActionLink, Button, ButtonGlyph, cx, EmptyState, FOCUS_RING, Notice, Select, Spinner, Toggle } from './ui'

/**
 * Общая обвязка для экранов раздела API: все они читают что-то с сервера,
 * умеют обновляться и одинаково ведут себя без подключения.
 */

/** Заглушка для экрана, открытого до подключения к серверу. */
export function NotConnected({ onGoToConnection }: { onGoToConnection: () => void }) {
  const { t } = useI18n()
  const rich = useRichText()
  return (
    <EmptyState
      icon={ArrowsLeftRight}
      title={t('api.notConnected')}
      text={rich('api.notConnected.text', {
        connection: <ActionLink onClick={onGoToConnection}>{t('link.connection')}</ActionLink>,
      })}
      action={<Button variant="primary" onClick={onGoToConnection}>{t('nav.connection')}</Button>}
    />
  )
}

export function ErrorBar({ error }: { error: string | null }) {
  if (!error) return null
  return <Notice tone="danger">{error}</Notice>
}

/**
 * Тело экрана: колонка на всю оставшуюся высоту с полями по краям.
 *
 * Одинаково у всех десяти экранов, и именно от него зависит, что таблица
 * прокручивается внутри себя, а не тянет за собой всю страницу.
 */
export function ScreenBody({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-4">{children}</div>
}

/**
 * Полоса показателей над содержимым экрана.
 *
 * Слева — числа, справа — действия над ними. На узком окне переносится
 * по строкам: четыре показателя и две кнопки в одну строку не помещаются,
 * а уезжать за край им нельзя.
 */
export function StatsBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-7 gap-y-3 rounded-xl border border-line bg-surface px-5 py-3.5">
      {children}
    </div>
  )
}

/**
 * Ряд «список слева — содержимое справа».
 *
 * Так устроены подключения, очереди, СОПС и доступ: выбор в узкой панели,
 * подробности рядом. От него зависит, что обе половины прокручиваются
 * внутри себя, а не тянут за собой страницу.
 */
export function ScreenBodyRow({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 gap-3">{children}</div>
}

/** Пустая таблица и «идёт загрузка» выглядят одинаково на всех экранах. */
export function TableMessage({ colSpan, busy, children }: { colSpan: number; busy?: boolean; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-10 text-center text-content-subtle">
        <Awaiting busy={busy}>{children}</Awaiting>
      </td>
    </tr>
  )
}

/**
 * Подпись состояния, которая крутится, пока данные идут.
 *
 * Одно слово «Читаем…» без движения не отличить от зависшего экрана.
 * Общая для таблиц и списков: значок и зазор везде одни и те же.
 */
export function Awaiting({ busy, children }: { busy?: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      {busy && <Spinner className="size-3.5 text-accent-content" />}
      {children}
    </span>
  )
}

/**
 * Прокручиваемая панель с содержимым экрана.
 *
 * `isolate` здесь не для красоты: внутри липкая шапка таблицы с `z-10`,
 * и без своего слоя это число спорит с выпадающими списками снаружи —
 * шапка выигрывала у списка фильтра и накрывала его собой.
 */
export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cx('isolate min-h-0 overflow-auto rounded-xl border border-line bg-surface', className)}>
      {children}
    </div>
  )
}

interface Resource<T> {
  data: T | null
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  setError: (error: string | null) => void
}

/**
 * Читает данные с сервера и перечитывает их при смене подключения.
 *
 * `load` обязан быть стабильным (useCallback) — иначе чтение зациклится.
 */
export function useApiData<T>(
  connection: Connection | null,
  load: (connection: Connection) => Promise<T>,
): Resource<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Номер последнего запроса: сменили область или домен, а ответ на прежний
  // пришёл позже — и в таблице лежали чужие данные под новой подписью.
  const request = useRef(0)

  const reload = useCallback(async () => {
    const ticket = ++request.current
    if (!connection) {
      setData(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await load(connection)
      if (ticket === request.current) setData(result)
    } catch (err) {
      if (ticket !== request.current) return
      setError(errorText(err))
      setData(null)
    } finally {
      if (ticket === request.current) setLoading(false)
    }
  }, [connection, load])

  useEffect(() => { void reload() }, [reload])

  return { data, loading, error, reload, setError }
}

/**
 * Значение, которое догоняет ввод с задержкой.
 *
 * Поиск в журналах и в аудите уходит на сервер, и без задержки запрос
 * улетал на каждое нажатие клавиши: на тысяче записей это заметно
 * подвешивало окно.
 */
export function useDebounced<T>(value: T, delay = 400): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return settled
}

/** Период автообновления: чаще смысла нет, счётчики шина считает не мгновенно. */
const REFRESH_MS = 10_000

/**
 * Повторяет чтение, пока включено. Действие берётся через ref, поэтому таймер
 * не перезапускается от каждой смены фильтров — иначе он бы никогда не срабатывал.
 */
export function useAutoRefresh(enabled: boolean, action: () => unknown) {
  const latest = useRef(action)
  latest.current = action

  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => { void latest.current() }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [enabled])
}

/**
 * Кнопка обновления — одна и та же на всех одиннадцати экранах.
 *
 * Раньше это была скопированная строка вёрстки, и любая правка значка
 * или размера крутилки означала одиннадцать одинаковых правок.
 */
export function RefreshButton({ busy, disabled, className, onClick }: {
  busy: boolean
  disabled?: boolean
  className?: string
  onClick: () => void
}) {
  const { t } = useI18n()
  return (
    <Button className={className} onClick={onClick} disabled={disabled ?? busy}>
      <ButtonGlyph busy={busy}><ArrowsClockwise size={14} weight="bold" /></ButtonGlyph>
      {t('action.refresh')}
    </Button>
  )
}

/**
 * Действия экрана в шапке приложения.
 *
 * Шапка живёт в `App`, а кнопки — на экране: и состояние, и обработчики
 * у них там. Портал позволяет оставить их на месте в коде, а показать
 * там, где им место на глаз, — в ряду «чем сменить конфигурацию».
 */
export function HeaderActions({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  // Узел шапки появляется в том же кадре, что и экран, поэтому ищем его
  // после отрисовки, а до тех пор не показываем ничего.
  useEffect(() => setHost(document.getElementById('header-actions')), [])
  return host ? createPortal(children, host) : null
}

/**
 * Список «сколько строк показывать»: журналы и аудит спрашивают одно и то же.
 */
export function LimitSelect({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const { t } = useI18n()
  return (
    <Select<number>
      ariaLabel={t('logs.limit')}
      className="w-32"
      value={value}
      onChange={onChange}
      options={[50, 200, 500, 1000].map((option) => ({ id: option, label: t('logs.lines', { count: option }) }))}
    />
  )
}

/**
 * Чип-фильтр со счётчиком: журналы и аудит устроены одинаково, и выглядеть
 * должны так же. Свой цвет активного состояния нужен только уровням журнала,
 * где красное и жёлтое несут смысл.
 */
export function FilterChip({ active, count, activeClass, className, title, onClick, children }: {
  active: boolean
  count?: ReactNode
  activeClass?: string
  className?: string
  title?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cx(
        'flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-[11.5px] transition',
        FOCUS_RING,
        active
          ? activeClass ?? 'border-accent/50 bg-accent/12 text-accent-content'
          : 'border-line-strong text-content-muted hover:bg-surface-3',
        className,
      )}
    >
      {children}
      {count !== undefined && count !== null && (
        <span className="rounded bg-surface-3 px-1 text-[10px] tabular-nums">{count}</span>
      )}
    </button>
  )
}

/** Переключатель автообновления — один и тот же на всех живых экранах. */
export function AutoRefreshToggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  const { t } = useI18n()
  return <Toggle checked={checked} onChange={onChange} label={t('logs.auto')} title={t('logs.autoHint')} />
}
