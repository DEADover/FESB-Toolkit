import { describe, expect, it } from 'vitest'

import {
  buildHealth, checkCertificates, checkDomains, checkInflight, checkModules, checkQueues, checkRoutes, daysLeft, worstLevel,
} from './health'
import type { ApiCertificate, DomainStat, ModuleRow, QueueManager, QueueRow, RouteSummary } from '../types'

const NOW = new Date('2026-09-25T12:00:00Z')

const domain = (name: string, active: boolean): DomainStat =>
  ({ guid: name, name, active, routes: 1, running: 1, success: 0, errors: 0, inflight: 0 })

const route = (name: string, failed: number, state = 'Started'): RouteSummary => ({
  id: name, name, domain: 'Orders', domainGuid: 'g', state, trace: false, traceBeans: [],
  processed: 10, failed, failuresHandled: 0, inflight: 0, minMs: null, meanMs: null, maxMs: null,
  lastProcessed: null, tags: [],
})

const cert = (alias: string, notAfter: string) => ({ alias, notAfter }) as ApiCertificate

const module = (name: string, patch: Partial<ModuleRow>): ModuleRow => ({
  name, label: name, active: true, running: true, warning: false, awaitRestart: false,
  awaitSystemRestart: false, dependencies: [], ...patch,
})

const manager = (id: string, patch: Partial<QueueManager> = {}): QueueManager =>
  ({ kind: 'QMS', id, broker: `QMS:${id}`, status: 'Started', running: true, autoStart: true, ...patch })

const queue = (name: string, messages: number, consumers: number, internal = false) =>
  ({ name, messages, consumers, internal }) as QueueRow

describe('сводка по стенду', () => {
  it('остановленные домены — предупреждение, по алфавиту', () => {
    const check = checkDomains({ data: [domain('Б', false), domain('А', false), domain('В', true)] })
    expect(check.level).toBe('warn')
    expect(check.count).toBe(2)
    expect(check.samples).toEqual(['А', 'Б'])
  })

  it('все домены запущены — порядок', () => {
    expect(checkDomains({ data: [domain('А', true)] }).level).toBe('ok')
  })

  it('ошибка запроса — «не удалось узнать», а не «всё хорошо»', () => {
    const check = checkDomains({ error: 'нет прав' })
    expect(check.level).toBe('unknown')
    expect(check.error).toBe('нет прав')
  })

  it('СОПС с ошибками считаются только запущенные, больше ошибок — выше', () => {
    const check = checkRoutes({ data: [route('a', 1), route('b', 7), route('c', 3, 'Stopped'), route('d', 0)] })
    expect(check.level).toBe('error')
    expect(check.samples).toEqual(['b (Orders)', 'a (Orders)'])
  })

  it('сертификаты: месяц и меньше — предупреждение, истёкший — ошибка и первым', () => {
    expect(checkCertificates({ data: { stores: [], certificates: [cert('ok', '2027-01-01T00:00:00Z')] } }, NOW).level).toBe('ok')
    const soon = checkCertificates({ data: { stores: [], certificates: [cert('soon', '2026-10-10T00:00:00Z')] } }, NOW)
    expect(soon.level).toBe('warn')
    const expired = checkCertificates({
      data: { stores: [], certificates: [cert('soon', '2026-10-10T00:00:00Z'), cert('old', '2026-09-01T00:00:00Z')] },
    }, NOW)
    expect(expired.level).toBe('error')
    expect(expired.samples).toEqual(['old', 'soon'])
  })

  it('дни до конца срока и нечитаемая дата', () => {
    expect(daysLeft('2026-09-27T12:00:00Z', NOW)).toBe(2)
    expect(daysLeft('когда-нибудь', NOW)).toBeNull()
  })

  it('зависшие обмены — дольше минуты', () => {
    const row = (duration: number) => ({ route: `r${duration}`, domain: 'D', duration }) as never
    const check = checkInflight({ data: [row(5_000), row(61_000), row(120_000)] })
    expect(check.count).toBe(2)
    expect(check.samples[0]).toBe('r120000 (D)')
  })

  it('модуль включён и не работает — ошибка; ждёт перезапуска — предупреждение', () => {
    expect(checkModules({ data: [module('qms', { awaitRestart: true })] }).level).toBe('warn')
    const check = checkModules({ data: [module('qme', { running: false }), module('qms', { awaitRestart: true })] })
    expect(check.level).toBe('error')
    expect(check.samples).toEqual(['qme', 'qms'])
    // Выключенный в конфигурации модуль и не должен работать.
    expect(checkModules({ data: [module('rqms', { active: false, running: false })] }).level).toBe('ok')
  })

  it('очереди: без читателей или больше тысячи; служебные не в счёт', () => {
    const check = checkQueues({
      data: [{
        manager: manager('QM'),
        queues: { data: [queue('a', 5, 0), queue('b', 5, 1), queue('c', 2000, 3), queue('DLQ', 50, 0, true)] },
      }],
    })
    expect(check.level).toBe('warn')
    expect(check.samples).toEqual(['c (QM)', 'a (QM)'])
  })

  it('остановленный менеджер с автозапуском — ошибка, без автозапуска — нет', () => {
    const idle = { error: 'не запрошено' }
    expect(checkQueues({ data: [{ manager: manager('X', { running: false, autoStart: false }), queues: idle }] }).level).toBe('ok')
    const check = checkQueues({ data: [{ manager: manager('X', { running: false }), queues: idle }] })
    expect(check.level).toBe('error')
    expect(check.samples).toEqual(['QMS:X'])
  })

  it('заголовок сводки — по самой тяжёлой строке', () => {
    const checks = buildHealth({
      domains: { data: [domain('А', false)] },
      routes: { data: [] },
      certificates: { error: 'нет прав' },
      inflight: { data: [] },
      modules: { data: [] },
      queues: { data: [] },
      now: NOW,
    })
    // Найденное — первым, остальное — в постоянном порядке.
    expect(checks.map((check) => check.id)).toEqual(['domains', 'certificates', 'modules', 'routes', 'inflight', 'queues'])
    expect(worstLevel(checks)).toBe('warn')
    expect(worstLevel(checks.filter((check) => check.level !== 'warn'))).toBe('unknown')
  })
})
