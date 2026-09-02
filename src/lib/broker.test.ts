import { describe, expect, it } from 'vitest'

import { blankBroker, blankProfile, type ConnectionProfile } from './connection'
import { brokerProfile, busHost, hasBroker } from './broker'

function stand(patch: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    ...blankProfile(),
    name: 'Тест',
    url: 'https://esb.corp:8181/manager',
    username: 'root',
    password: 'secret',
    ...patch,
  }
}

describe('busHost', () => {
  it('оставляет от адреса шины один узел', () => {
    expect(busHost('https://esb.corp:8181/manager')).toBe('esb.corp')
    expect(busHost('http://10.0.0.5:8080')).toBe('10.0.0.5')
    expect(busHost('  esb.corp/manager  ')).toBe('esb.corp')
  })

  it('на пустом адресе не выдумывает узел', () => {
    expect(busHost('')).toBe('')
  })
})

describe('brokerProfile', () => {
  it('берёт у шины узел и учётные данные, пока брокер молчит', () => {
    const profile = brokerProfile(stand())
    expect(profile.host).toBe('esb.corp')
    expect(profile.username).toBe('root')
    expect(profile.password).toBe('secret')
    // Порт у брокера свой: порт шины ему не подходит.
    expect(profile.port).toBe(5672)
  })

  it('свои поля брокера сильнее унаследованных', () => {
    const profile = brokerProfile(stand({
      broker: { ...blankBroker(), host: 'broker.corp', port: '5671', username: 'amqp', password: 'pw' },
    }))
    expect(profile.host).toBe('broker.corp')
    expect(profile.port).toBe(5671)
    expect(profile.username).toBe('amqp')
    expect(profile.password).toBe('pw')
  })

  it('вход без учётных данных не тащит за собой пароль шины', () => {
    const profile = brokerProfile(stand({ broker: { ...blankBroker(), saslAnonymous: true } }))
    expect(profile.username).toBe('')
    expect(profile.password).toBe('')
  })

  it('нечисловые значения не превращаются в NaN', () => {
    const profile = brokerProfile(stand({
      broker: { ...blankBroker(), port: 'пять тысяч', heartbeatSecs: '', sendRetryAttempts: '0' },
    }))
    expect(profile.port).toBe(5672)
    expect(profile.heartbeat_secs).toBe(0)
    // Ноль попыток означал бы, что отправки не будет вовсе.
    expect(profile.send_retry_attempts).toBe(1)
  })

  it('имя стенда становится именем профиля брокера', () => {
    expect(brokerProfile(stand()).name).toBe('Тест')
  })
})

describe('hasBroker', () => {
  it('видит брокер там, где есть узел — свой или унаследованный', () => {
    expect(hasBroker(stand())).toBe(true)
    expect(hasBroker(stand({ url: '', broker: { ...blankBroker(), host: 'broker.corp' } }))).toBe(true)
  })

  it('без узла подключаться некуда', () => {
    expect(hasBroker(stand({ url: '' }))).toBe(false)
  })
})
