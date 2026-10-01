import { describe, expect, it } from 'vitest'

import type { TraceBean } from '../types'
import {
  changesFor, currentValues, emptyUpdate, expectedOptions, optionValueLabel, updateEntries, validCount,
} from './traceOptions'

function bean(kind: TraceBean['kind'], options: Record<string, string>): TraceBean {
  return {
    beanId: 'TraceToQueue', beanName: 'TraceToQueue', broker: 'QME:EQM', queue: 'Mon.Trace',
    clientType: 'TEMPLATE', traceMode: 'ASYNC', kind, blocking: null, line: 1,
    brokerEditable: kind !== 'memory', queueEditable: kind !== 'memory', traceModeEditable: kind !== 'memory',
    options,
  }
}

const QUEUE = bean('queue', { addBody: 'true', threads: '1', 'events.TRACE_ENDPOINT': 'true' })
const MEMORY = bean('memory', { addBody: 'false', threads: '1' })
const NO_EVENTS = bean('queue', { addBody: 'true' })

const t = (key: string) => ({ 'opt.yes': 'Да', 'opt.no': 'Нет', 'opt.unset': 'Не задано', 'opt.traceMode.ASYNC_NEW': 'Асинхронный' }[key] ?? key)

describe('changesFor', () => {
  it('считает только то, что действительно поменяется', () => {
    const update = { ...emptyUpdate(), options: { addBody: 'false', threads: '4', headerPrefix: 'mch_' } }
    // addBody, threads и дописанный префикс.
    expect(changesFor(QUEUE, update)).toBe(3)
    // У объекта в памяти нет потоков, а addBody уже нужный.
    expect(changesFor(MEMORY, update)).toBe(1)
  })

  it('не создаёт список событий там, где его нет', () => {
    const update = { ...emptyUpdate(), options: { 'events.TRACE_ENDPOINT': 'false' } }
    expect(changesFor(QUEUE, update)).toBe(1)
    expect(changesFor(NO_EVENTS, update)).toBe(0)
  })

  it('менеджер у объекта в памяти не считается', () => {
    expect(changesFor(MEMORY, { ...emptyUpdate(), broker: 'QMS:QM' })).toBe(0)
    expect(changesFor(QUEUE, { ...emptyUpdate(), broker: 'QMS:QM' })).toBe(1)
  })
})

describe('currentValues', () => {
  it('сводит значения выбранных объектов и пропускает тех, кому параметр не положен', () => {
    expect(currentValues([QUEUE, MEMORY, NO_EVENTS], 'addBody')).toEqual([
      { value: 'true', count: 2 }, { value: 'false', count: 1 },
    ])
    expect(currentValues([QUEUE, MEMORY], 'threads')).toEqual([{ value: '1', count: 1 }])
    expect(currentValues([QUEUE, NO_EVENTS], 'headerPrefix')).toEqual([{ value: null, count: 2 }])
  })
})

describe('updateEntries', () => {
  it('ставит поля панели первыми, остальное — в порядке редактора шины', () => {
    const update = { broker: 'QMS:QM', queue: null, traceMode: 'SYNC', options: { headerPrefix: 'h_', addBody: 'true' } }
    expect(updateEntries(update).map(([key]) => key)).toEqual(['broker', 'traceMode', 'addBody', 'headerPrefix'])
  })
})

it('числа проверяются так же, как в редакторе шины', () => {
  expect(validCount('1000')).toBe(true)
  expect(validCount('0')).toBe(false)
  expect(validCount('1.5')).toBe(false)
  expect(validCount('1073741824')).toBe(false)
})

it('значения подписываются по-человечески', () => {
  expect(optionValueLabel('addBody', 'true', t as never)).toBe('Да')
  expect(optionValueLabel('events.TRACE_ENDPOINT', 'false', t as never)).toBe('Нет')
  expect(optionValueLabel('traceMode', 'ASYNC_NEW', t as never)).toBe('Асинхронный')
  expect(optionValueLabel('queueSize', null, t as never)).toBe('Не задано')
})

it('ожидаемые значения берутся только по тем ключам, что меняются', () => {
  const update = { ...emptyUpdate(), options: { addBody: 'false', headerPrefix: 'h_' } }
  expect(expectedOptions(QUEUE, update)).toEqual({ addBody: 'true', headerPrefix: null })
})
