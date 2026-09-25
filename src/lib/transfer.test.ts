import { describe, expect, it } from 'vitest'

import { planTransfer } from './transfer'
import type { DiffRow } from '../types'

const row = (side: DiffRow['side'], scope: string, name: string, left: string | null, right: string | null): DiffRow =>
  ({ side, scope, name, left, right })

describe('перенос разницы', () => {
  const constants = [
    row('onlyLeft', 'application', 'url.a', 'http://a', null),
    row('differs', 'Orders', 'retry', '3', '5'),
    row('onlyRight', 'broker', 'url.b', null, 'http://b'),
  ]

  it('туда: новые константы создаются, отличающиеся заменяются, чужих нет', () => {
    const plan = planTransfer(constants, 'properties', 'toOther')
    expect(plan.constants).toEqual([
      { scope: 'application', key: 'url.a', value: 'http://a', current: null },
      { scope: { domainName: 'Orders' }, key: 'retry', value: '3', current: '5' },
    ])
    expect(plan.skipped.map((item) => [item.row.name, item.reason])).toEqual([['url.b', 'nothingThere']])
  })

  it('сюда: берётся значение второго стенда', () => {
    const plan = planTransfer(constants, 'properties', 'toHere')
    expect(plan.constants.map((move) => [move.key, move.value, move.current])).toEqual([
      ['retry', '5', '3'],
      ['url.b', 'http://b', null],
    ])
  })

  it('СОПС переносятся доменом целиком, домен — один раз', () => {
    const plan = planTransfer([
      row('differs', 'Orders', 'Orders.In', 'TraceToQueue', 'off'),
      row('onlyLeft', 'Orders', 'Orders.Out', 'off', null),
      row('onlyLeft', 'Billing', 'Pay', 'off', null),
    ], 'routes', 'toOther')
    expect(plan.domains).toEqual(['Billing', 'Orders'])
    expect(plan.constants).toEqual([])
  })

  it('домены — только с открытого стенда', () => {
    const plan = planTransfer([row('onlyRight', '', 'Payments', null, null)], 'domains', 'toHere')
    expect(plan.domains).toEqual([])
    expect(plan.skipped[0].reason).toBe('domainsOneWay')
    expect(planTransfer([row('onlyLeft', '', 'Old', null, null)], 'domains', 'toHere').skipped[0].reason).toBe('nothingThere')
    const back = planTransfer([row('differs', 'Orders', 'R', 'on', 'off')], 'routes', 'toHere')
    expect(back.skipped[0].reason).toBe('domainsOneWay')
    expect(planTransfer([row('onlyLeft', '', 'Payments', null, null)], 'domains', 'toOther').domains).toEqual(['Payments'])
  })
})
