import { describe, expect, it } from 'vitest'

import { blankProfile, busUrl, toConnection, type ConnectionProfile } from './connection'

function stand(patch: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return { ...blankProfile(), url: 'esb.corp', port: '8181', username: 'root', ...patch }
}

describe('busUrl', () => {
  it('приставляет порт из своего поля', () => {
    expect(busUrl(stand())).toBe('esb.corp:8181')
  })

  it('пустой порт означает порт по умолчанию для схемы', () => {
    expect(busUrl(stand({ port: '' }))).toBe('esb.corp')
    expect(busUrl(stand({ port: '   ' }))).toBe('esb.corp')
  })

  it('не трогает адрес, где порт уже указан', () => {
    expect(busUrl(stand({ url: 'esb.corp:9443', port: '8181' }))).toBe('esb.corp:9443')
  })

  it('ставит порт после узла, а не в конец адреса', () => {
    expect(busUrl(stand({ url: 'https://esb.corp/manager' }))).toBe('https://esb.corp:8181/manager')
  })

  it('переживает схему и хвостовую косую', () => {
    expect(busUrl(stand({ url: 'http://localhost/' }))).toBe('http://localhost:8181')
  })

  it('на пустом узле ничего не выдумывает', () => {
    expect(busUrl(stand({ url: '   ' }))).toBe('')
  })
})

describe('toConnection', () => {
  it('отдаёт бэкенду адрес вместе с портом', () => {
    expect(toConnection(stand()).url).toBe('esb.corp:8181')
  })
})
