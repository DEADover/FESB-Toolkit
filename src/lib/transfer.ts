// Перенос найденной разницы с одного стенда на другой.
//
// Сравнение показывает, чего где не хватает; перенос закрывает разницу, не
// уходя с экрана. Здесь только план: что будет записано и что перенести
// нельзя и почему. Записывает диалог — после того, как человек план увидел.

import type { DiffRow, Side } from '../types'

/** `toOther` — с открытого стенда на второй, `toHere` — наоборот. */
export type Direction = 'toOther' | 'toHere'

export type Part = 'domains' | 'routes' | 'properties'

/** Уровень константы: приложение, брокер или домен по имени. */
export type ConstantScope = 'application' | 'broker' | { domainName: string }

export interface ConstantMove {
  scope: ConstantScope
  key: string
  value: string
  /** Какое значение сейчас на целевом стенде; `null` — константы там нет. */
  current: string | null
}

export type SkipReason = 'nothingThere' | 'domainsOneWay'

export interface TransferPlan {
  constants: ConstantMove[]
  /** Домены, которые надо скопировать целиком, — по именам на исходном стенде. */
  domains: string[]
  skipped: Array<{ row: DiffRow; reason: SkipReason }>
}

/** Есть ли что брать со стороны-источника. */
function hasSource(side: Side, direction: Direction): boolean {
  if (side === 'differs') return true
  return direction === 'toOther' ? side === 'onlyLeft' : side === 'onlyRight'
}

function scopeOf(row: DiffRow): ConstantScope {
  if (row.scope === 'application' || row.scope === 'broker') return row.scope
  return { domainName: row.scope }
}

/**
 * Константы пишутся по одной; домены и СОПС копируются доменом целиком —
 * по-другому шина СОПС не принимает. Копирование доменов умеет только
 * отдавать с открытого стенда, поэтому в обратную сторону домены не идут.
 */
export function planTransfer(rows: DiffRow[], part: Part, direction: Direction): TransferPlan {
  const plan: TransferPlan = { constants: [], domains: [], skipped: [] }
  const domains = new Set<string>()
  for (const row of rows) {
    if (!hasSource(row.side, direction)) {
      plan.skipped.push({ row, reason: 'nothingThere' })
      continue
    }
    if (part === 'properties') {
      const value = direction === 'toOther' ? row.left : row.right
      const current = direction === 'toOther' ? row.right : row.left
      plan.constants.push({ scope: scopeOf(row), key: row.name, value: value ?? '', current })
      continue
    }
    if (direction === 'toHere') {
      plan.skipped.push({ row, reason: 'domainsOneWay' })
      continue
    }
    // У строки домена имя — в `name`, у строки СОПС домен — в `scope`.
    domains.add(part === 'domains' ? row.name : row.scope)
  }
  plan.domains = [...domains].sort((a, b) => a.localeCompare(b))
  return plan
}

/** Ключ строки сравнения — для отметок в таблице. */
export function diffKey(row: DiffRow): string {
  return `${row.side}/${row.scope}/${row.name}`
}
