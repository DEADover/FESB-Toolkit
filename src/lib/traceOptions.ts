import type { MessageKey, Translate } from '../i18n'
import type { TraceBean, TraceUpdate } from '../types'

/**
 * Параметры объекта трассировки, которые правятся массово.
 *
 * Список повторяет форму объекта трассировки в редакторе домена FESB и тот же
 * список на стороне приложения (`trace_options.rs`): ключи, допустимые
 * значения, кому что положено. Поля трассировки с Groovy-выражениями сюда
 * не входят.
 *
 * События в файле — один список, а правятся поштучно: ключ
 * `events.<ИМЯ>` со значением `true` / `false`. Так «выключить событие точки
 * обработки» на сотне объектов не трогает остальные события каждого из них.
 */
export type OptionKind = 'text' | 'flag' | 'count' | 'choice' | 'event'

export type OptionGroup = 'events' | 'queue' | 'content' | 'prefix'

export interface TraceOption {
  key: string
  kind: OptionKind
  group: OptionGroup
  label: MessageKey
  /** Бывает только у объекта, который пишет в очередь. */
  queueOnly: boolean
  choices?: string[]
}

export const COUNT_MAX = 1_073_741_823

export const TRACE_MODES = ['ASYNC_NEW', 'ASYNC', 'SYNC']

const option = (key: string, kind: OptionKind, group: OptionGroup, queueOnly = false, choices?: string[]): TraceOption => ({
  key, kind, group, queueOnly, choices, label: `opt.${key}` as MessageKey,
})

/** Порядок — как в редакторе шины. Менеджер, очередь и режим стоят на панели, здесь их нет. */
export const TRACE_OPTIONS: TraceOption[] = [
  option('events.TRACE_BEFORE_ROUTE', 'event', 'events'),
  option('events.TRACE_ENDPOINT', 'event', 'events'),
  option('events.TRACE_AFTER_ROUTE', 'event', 'events'),
  option('clientType', 'choice', 'queue', true, ['NATIVE', 'TEMPLATE', 'ENDPOINT']),
  option('queueType', 'choice', 'queue', false, ['LIMITED', 'UNLIMITED']),
  option('queueSize', 'count', 'queue'),
  option('threads', 'count', 'queue', true),
  option('schedulerPeriod', 'count', 'queue', true),
  option('handleErrors', 'flag', 'content'),
  option('captureOriginalEvent', 'flag', 'content'),
  option('addBody', 'flag', 'content'),
  option('convertBodyToString', 'flag', 'content'),
  option('convertSteamToString', 'flag', 'content'),
  option('addAllHeaders', 'flag', 'content'),
  option('addAllProperties', 'flag', 'content'),
  option('convertValues', 'flag', 'content'),
  option('convertDateToUnix', 'flag', 'content'),
  option('saveBreadcrumbToProperties', 'flag', 'content'),
  option('generateTraceStepId', 'flag', 'content'),
  option('headerPrefix', 'text', 'prefix'),
  option('propertyPrefix', 'text', 'prefix'),
]

export const OPTION_GROUPS: Array<{ id: OptionGroup; label: MessageKey }> = [
  { id: 'events', label: 'opt.group.events' },
  { id: 'queue', label: 'opt.group.queue' },
  { id: 'content', label: 'opt.group.content' },
  { id: 'prefix', label: 'opt.group.prefix' },
]

const BY_KEY = new Map(TRACE_OPTIONS.map((item) => [item.key, item]))

export function findOption(key: string): TraceOption | undefined {
  return BY_KEY.get(key)
}

export function emptyUpdate(): TraceUpdate {
  return { broker: null, queue: null, traceMode: null, options: {} }
}

/** Годится ли значение числового параметра — так же его проверяет редактор шины. */
export function validCount(value: string): boolean {
  if (!/^\d+$/.test(value.trim())) return false
  const number = Number(value)
  return number >= 1 && number <= COUNT_MAX
}

/** Как значение выглядит на экране: «Да», «Асинхронный», «1000». */
export function optionValueLabel(key: string, value: string | null, t: Translate): string {
  if (value === null) return t('opt.unset')
  const item = key === 'traceMode' ? { kind: 'choice' as const } : findOption(key)
  if (!item) return value
  if (item.kind === 'flag' || item.kind === 'event') return value === 'true' ? t('opt.yes') : t('opt.no')
  if (item.kind === 'choice') return t(`opt.${key}.${value}` as MessageKey)
  return value
}

/** Название параметра для отчёта и подтверждения; незнакомый ключ — как есть. */
export function optionLabel(key: string, t: Translate): string {
  if (key === 'broker') return t('table.broker')
  if (key === 'queue') return t('table.queue')
  if (key === 'traceMode') return t('opt.traceMode')
  const item = findOption(key)
  return item ? t(item.label) : key
}

/** Все правки одним списком: менеджер, очередь и режим — первыми, как на панели. */
export function updateEntries(update: TraceUpdate): Array<[string, string]> {
  const own: Array<[string, string | null]> = [
    ['broker', update.broker], ['queue', update.queue], ['traceMode', update.traceMode],
  ]
  return [
    ...own.filter((pair): pair is [string, string] => pair[1] !== null),
    ...TRACE_OPTIONS.filter((item) => item.key in update.options).map((item): [string, string] => [item.key, update.options[item.key]]),
  ]
}

export function hasChanges(update: TraceUpdate): boolean {
  return updateEntries(update).length > 0
}

function currentOf(trace: TraceBean, key: string): string | null {
  if (key === 'broker') return trace.broker
  if (key === 'queue') return trace.queue
  if (key === 'traceMode') return trace.traceMode
  return trace.options[key] ?? null
}

/**
 * Сколько значений правка действительно поменяет у объекта.
 *
 * Не считаются: уже нужное значение, параметр, которого у такого объекта
 * не бывает, и событие у объекта без списка событий — его приложение
 * из ничего не создаёт. Ровно так же решает и запись в файл.
 */
export function changesFor(trace: TraceBean, update: TraceUpdate): number {
  let count = 0
  for (const [key, value] of updateEntries(update)) {
    if (key === 'broker' && !trace.brokerEditable) continue
    if (key === 'queue' && !trace.queueEditable) continue
    if (key === 'traceMode' && !trace.traceModeEditable) continue
    const item = findOption(key)
    if (item?.queueOnly && trace.kind === 'memory') continue
    if (item?.kind === 'event' && !(key in trace.options)) continue
    if (currentOf(trace, key) !== value) count++
  }
  return count
}

/** Какие значения параметра сейчас у выбранных объектов — по убыванию частоты. */
export function currentValues(traces: TraceBean[], key: string): Array<{ value: string | null; count: number }> {
  const counts = new Map<string | null, number>()
  const item = findOption(key)
  for (const trace of traces) {
    if (item?.queueOnly && trace.kind === 'memory') continue
    const value = currentOf(trace, key)
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)))
}

/** Значения, которые пользователь видел при выборе: по ним запись отличит чужую правку. */
export function expectedOptions(trace: TraceBean, update: TraceUpdate): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const key of Object.keys(update.options)) out[key] = trace.options[key] ?? null
  return out
}
