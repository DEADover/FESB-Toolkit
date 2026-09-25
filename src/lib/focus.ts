// Куда вести, когда переход приходит не из меню, а из другого места:
// из палитры, из строки обмена. Экран открывается уже настроенным —
// нужный домен выбран, в поиске стоит имя, схема СОПС раскрыта.

import type { ManagerKind } from '../types'

/** Журнал одного обмена: записи его СОПС, строки его потока подсвечены. */
export interface LogFocus {
  screen: 'api.logs'
  /** Префикс, с которого FESB начинает каждую запись СОПС: `[Домен/СОПС]`. */
  search: string
  /** Хвост имени потока в том виде, в каком он лежит в журнале. */
  thread: string | null
  exchangeId: string
  /** Что показывать в полосе над журналом: СОПС и домен. */
  label: string
}

export type Focus =
  | { screen: 'api.routes'; guid: string; route?: string }
  | { screen: 'api.properties'; query: string }
  | { screen: 'api.queues'; manager: { kind: ManagerKind; id: string }; query: string }
  | LogFocus

/**
 * Сколько знаков имени потока пишет журнал. В шаблоне FESB стоит
 * `%-20.20thread`: длинное имя обрезается слева, остаётся хвост —
 * у потока таймера это `timer://toolkit.slow`.
 */
export const LOG_THREAD_WIDTH = 20

export function threadTail(thread: string | null): string | null {
  if (!thread) return null
  return thread.length > LOG_THREAD_WIDTH ? thread.slice(-LOG_THREAD_WIDTH) : thread
}

/** Переход к журналу обмена. */
export function exchangeLogFocus(exchange: { id: string; domain: string; route: string; thread: string | null }): LogFocus {
  return {
    screen: 'api.logs',
    search: `[${exchange.domain}/${exchange.route}]`,
    thread: threadTail(exchange.thread),
    exchangeId: exchange.id,
    label: `${exchange.route} (${exchange.domain})`,
  }
}

/**
 * Запись относится к обмену, если в ней его идентификатор или если её
 * записал его поток. Поток — не железное доказательство: пул отдаёт его
 * следующему обмену, — поэтому такие строки только подсвечиваются, а не
 * отбираются.
 */
export function belongsToExchange(entry: { thread: string | null; message: string | null }, focus: LogFocus): boolean {
  if (focus.exchangeId && entry.message?.includes(focus.exchangeId)) return true
  return focus.thread !== null && entry.thread?.trim() === focus.thread.trim()
}
