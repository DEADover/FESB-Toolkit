import { describe, expect, it } from 'vitest'

import type { Translate } from '../i18n'
import type { JournalEntrySummary, JournalItem, UndoRow } from '../types'
import { changeTexts, currentText, entryResult, entryTargets, formatStamp, originLabel, undoTarget } from './journal'

const WORDS: Record<string, string> = {
  'journal.trace.on': 'Включена',
  'journal.trace.off': 'Выключена',
  'journal.trace.default': 'Объект по умолчанию',
  'journal.constant.absent': 'Нет',
  'journal.constant.empty': 'Пусто',
  'journal.constant.hidden': 'Скрыто',
  'journal.domain.existed': 'Был, копия сохранена',
  'journal.domain.absent': 'Не было',
  'journal.domain.loaded': 'Загружен',
  'journal.domain.deleted': 'Удалён',
  'journal.undo.domain.restore': 'Вернётся из копии',
  'journal.undo.domain.delete': 'Будет удалён',
  'journal.origin.routeTrace': 'Трассировка СОПС',
  'journal.action.stop': 'Остановка',
}
const t = ((key: string, values?: Record<string, string | number>) => {
  if (key === 'journal.result.changes') return `Правок: ${values?.count}`
  if (key === 'journal.result.failed') return `Ошибок: ${values?.count}`
  if (key === 'journal.targets.more') return `и ещё ${values?.count}`
  return WORDS[key] ?? key
}) as Translate

const TRACE: JournalItem = {
  type: 'routeTrace', at: '2026-10-05T13:05:04', domainGuid: 'd', domain: 'ERP', routeId: 'r', route: 'Orders.In',
  before: { trace: false, config: null }, after: { trace: true, config: 'TraceToQueue' },
}

describe('changeTexts', () => {
  it('трассировка читается словами, пустой объект — как объект по умолчанию', () => {
    expect(changeTexts(TRACE, t)).toEqual({
      before: 'Выключена · Объект по умолчанию',
      after: 'Включена · TraceToQueue',
    })
  })

  it('скрытая константа не показывает значения, созданная — «Нет» до', () => {
    const item: JournalItem = {
      type: 'constant', at: '', scope: 'broker', domain: null, key: 'password',
      before: null, after: { value: null, description: null, secured: true, vault: false },
    }
    expect(changeTexts(item, t)).toEqual({ before: 'Нет', after: 'Скрыто' })
  })

  it('домен: был ли он и что с ним сделали', () => {
    const item: JournalItem = {
      type: 'domain', at: '', guid: 'g', name: 'ERP', existed: true, backup: 'g.zip', group: null, mode: null,
      activeBefore: true, deleted: false,
    }
    expect(changeTexts(item, t)).toEqual({ before: 'Был, копия сохранена', after: 'Загружен' })
  })

  it('действие показывает подробность', () => {
    const item: JournalItem = {
      type: 'action', at: '', target: 'messages', domain: 'QME:EQM', name: 'DLQ', action: 'stop', detail: '3',
    }
    expect(changeTexts(item, t).after).toBe('Остановка · 3')
  })
})

describe('строка записи', () => {
  const entry: JournalEntrySummary = {
    id: 'j', server: 's', user: 'root', origin: 'routeTrace', startedAt: '2026-10-05T13:05:04',
    changes: 12, actions: 0, failed: 1, targets: ['ERP · A', 'ERP · B', 'WMS · C'], total: 13, kinds: ['routeTrace'],
  }

  it('итог и объекты', () => {
    expect(entryResult(entry, t)).toBe('Правок: 12 · Ошибок: 1')
    expect(entryTargets(entry, t)).toBe('ERP · A, ERP · B, WMS · C и ещё 10')
  })

  it('дата и подпись операции', () => {
    expect(formatStamp(entry.startedAt)).toBe('05.10.2026 13:05')
    expect(originLabel('routeTrace', t)).toBe('Трассировка СОПС')
    expect(originLabel('somethingNew', t)).toBe('somethingNew')
  })
})

describe('отмена', () => {
  it('расхождение показывает, что на стенде сейчас', () => {
    const row: UndoRow = { index: 0, item: TRACE, state: 'conflict', reason: null, current: { trace: true, config: 'MC.TRACE' } }
    expect(currentText(row, t)).toBe('Включена · MC.TRACE')
    expect(undoTarget(row, t)).toBe('Выключена · Объект по умолчанию')
  })

  it('пропавшая константа — «Нет»', () => {
    const item: JournalItem = {
      type: 'constant', at: '', scope: 'application', domain: null, key: 'url',
      before: { value: 'a', description: null, secured: false, vault: false },
      after: { value: 'b', description: null, secured: false, vault: false },
    }
    expect(currentText({ index: 0, item, state: 'conflict', reason: null, current: null }, t)).toBe('Нет')
  })

  it('новый домен при отмене удаляется, перезаписанный — возвращается', () => {
    const base = { type: 'domain' as const, at: '', guid: 'g', name: 'ERP', backup: null, group: null, mode: null, activeBefore: false, deleted: false }
    expect(undoTarget({ index: 0, item: { ...base, existed: false }, state: 'ready', reason: null, current: null }, t)).toBe('Будет удалён')
    expect(undoTarget({ index: 0, item: { ...base, existed: true }, state: 'ready', reason: null, current: null }, t)).toBe('Вернётся из копии')
  })
})
