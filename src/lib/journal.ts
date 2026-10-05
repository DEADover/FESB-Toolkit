import type { MessageKey, Translate } from '../i18n'
import type { JournalConstant, JournalEntrySummary, JournalItem, RouteTraceState, UndoRow } from '../types'

/** Откуда операция — подпись записи в журнале. */
const ORIGIN: Record<string, MessageKey> = {
  routeTrace: 'journal.origin.routeTrace',
  constants: 'journal.origin.constants',
  transfer: 'journal.origin.transfer',
  copy: 'journal.origin.copy',
  push: 'journal.origin.push',
  domains: 'journal.origin.domains',
  routes: 'journal.origin.routes',
  modules: 'journal.origin.modules',
  savePoints: 'journal.origin.savePoints',
  messages: 'journal.origin.messages',
  mqConfig: 'journal.origin.mqConfig',
  undo: 'journal.origin.undo',
}

export function originLabel(origin: string, t: Translate): string {
  const key = ORIGIN[origin]
  return key ? t(key) : origin
}

const ACTION: Record<string, MessageKey> = {
  start: 'journal.action.start',
  stop: 'journal.action.stop',
  restart: 'journal.action.restart',
  reset: 'journal.action.reset',
  trace: 'journal.action.trace',
  retry: 'journal.action.retry',
  move: 'journal.action.move',
  copy: 'journal.action.copy',
  delete: 'journal.action.delete',
  store: 'journal.action.store',
  unstore: 'journal.action.unstore',
  create: 'journal.action.create',
  rollback: 'journal.action.rollback',
}

export function actionLabel(action: string, t: Translate): string {
  const key = ACTION[action]
  return key ? t(key) : action
}

/** `2026-10-05T13:05:04` → `05.10.2026 13:05`. */
export function formatStamp(at: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(at)
  return match ? `${match[3]}.${match[2]}.${match[1]} ${match[4]}:${match[5]}` : at
}

/** Время без даты — для строк внутри одной записи. */
export function formatTime(at: string): string {
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(at)
  return match ? match[1] : at
}

export function traceText(state: RouteTraceState, t: Translate): string {
  const on = state.trace ? t('journal.trace.on') : t('journal.trace.off')
  return `${on} · ${state.config ?? t('journal.trace.default')}`
}

export function constantText(value: JournalConstant | null, t: Translate): string {
  if (value === null) return t('journal.constant.absent')
  if (value.secured || value.vault) return t('journal.constant.hidden')
  if (!value.value) return t('journal.constant.empty')
  return value.value
}

/** Как объект называется в строке: «Домен · СОПС». */
export function itemTitle(item: JournalItem): { domain: string | null; name: string } {
  switch (item.type) {
    case 'routeTrace': return { domain: item.domain, name: item.route ?? item.routeId }
    case 'constant': return { domain: item.domain, name: item.key }
    case 'domain': return { domain: null, name: item.name }
    case 'action': return { domain: item.domain, name: item.name }
  }
}

/** Что было и что стало — двумя строками для таблицы. */
export function changeTexts(item: JournalItem, t: Translate): { before: string; after: string } {
  switch (item.type) {
    case 'routeTrace':
      return { before: traceText(item.before, t), after: traceText(item.after, t) }
    case 'constant':
      return { before: constantText(item.before, t), after: constantText(item.after, t) }
    case 'domain':
      return {
        before: item.existed
          ? (item.backup ? t('journal.domain.existed') : t('journal.domain.existedNoCopy'))
          : t('journal.domain.absent'),
        after: item.deleted ? t('journal.domain.deleted') : t('journal.domain.loaded'),
      }
    case 'action':
      return {
        before: '—',
        after: item.detail ? `${actionLabel(item.action, t)} · ${item.detail}` : actionLabel(item.action, t),
      }
  }
}

/** Итог записи одной строкой: «12 изменений · 1 ошибка». */
export function entryResult(entry: JournalEntrySummary, t: Translate): string {
  const parts: string[] = []
  if (entry.changes > 0) parts.push(t('journal.result.changes', { count: entry.changes }))
  if (entry.actions > 0) parts.push(t('journal.result.actions', { count: entry.actions }))
  if (entry.failed > 0) parts.push(t('journal.result.failed', { count: entry.failed }))
  return parts.join(' · ')
}

/** Объекты записи: первые три и сколько ещё. */
export function entryTargets(entry: JournalEntrySummary, t: Translate): string {
  const rest = entry.total - entry.targets.length
  const shown = entry.targets.join(', ')
  return rest > 0 ? `${shown} ${t('journal.targets.more', { count: rest })}` : shown
}

/** В записи есть что возвращать. */
export function canUndo(entry: JournalEntrySummary): boolean {
  return entry.changes > 0
}

/** Почему изменение нельзя вернуть — по коду от бэкенда. */
const REASON: Record<string, MessageKey> = {
  failed: 'journal.undo.reason.failed',
  action: 'journal.undo.reason.action',
  secured: 'journal.undo.reason.secured',
  noBackup: 'journal.undo.reason.noBackup',
  unreadable: 'journal.undo.reason.unreadable',
  ready: 'journal.undo.state.ready',
  done: 'journal.undo.state.done',
  conflict: 'journal.undo.state.conflict',
  impossible: 'journal.undo.state.impossible',
}

export function reasonText(reason: string | null, t: Translate): string {
  if (!reason) return ''
  const key = REASON[reason]
  return key ? t(key) : reason
}

/** Что на сервере сейчас — у расхождения. */
export function currentText(row: UndoRow, t: Translate): string | null {
  const current = row.current
  if (current === null || current === undefined) return row.item.type === 'constant' ? constantText(null, t) : null
  if (typeof current === 'string') return current
  if ('trace' in current) return traceText(current, t)
  return constantText(current, t)
}

/** Что станет после отмены: то, что было до операции. */
export function undoTarget(row: UndoRow, t: Translate): string {
  const item = row.item
  if (item.type === 'domain') {
    return item.existed ? t('journal.undo.domain.restore') : t('journal.undo.domain.delete')
  }
  return changeTexts(item, t).before
}
