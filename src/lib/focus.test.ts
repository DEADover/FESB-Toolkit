import { describe, expect, it } from 'vitest'

import { belongsToExchange, exchangeLogFocus, threadTail } from './focus'

// Как на стенде: поток таймера целиком и то, что от него осталось в журнале.
const THREAD = 'Camel (domain-70011c17-0000-4000-8000-00000000c0de) thread #8 - timer://toolkit.slow'

describe('журнал обмена', () => {
  it('ищет по префиксу, с которого FESB начинает записи СОПС', () => {
    const focus = exchangeLogFocus({ id: 'X-1', domain: 'TOOLKIT.INFLIGHT', route: 'Toolkit.SlowExchange', thread: THREAD })
    expect(focus.search).toBe('[TOOLKIT.INFLIGHT/Toolkit.SlowExchange]')
    expect(focus.thread).toBe('timer://toolkit.slow')
  })

  it('от имени потока в журнале остаётся хвост в двадцать знаков', () => {
    expect(threadTail(THREAD)).toBe('timer://toolkit.slow')
    expect(threadTail('main')).toBe('main')
    expect(threadTail(null)).toBeNull()
  })

  it('запись — своя по потоку или по идентификатору обмена', () => {
    const focus = exchangeLogFocus({ id: '8E54-01', domain: 'D', route: 'R', thread: THREAD })
    expect(belongsToExchange({ thread: 'timer://toolkit.slow', message: 'x' }, focus)).toBe(true)
    expect(belongsToExchange({ thread: 'other', message: 'done: 8E54-01' }, focus)).toBe(true)
    expect(belongsToExchange({ thread: 'other', message: 'x' }, focus)).toBe(false)
  })
})
