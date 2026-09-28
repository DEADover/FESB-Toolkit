import { describe, expect, it } from 'vitest'

import { blankBroker, blankProfile, EMPTY_STORE, type ConnectionProfile } from './connection'
import { applyImport, exportStands, parseStands, planImport, standsFileName, StandsFileProblem } from './standsFile'

const stand = (patch: Partial<ConnectionProfile>): ConnectionProfile => ({
  ...blankProfile(),
  url: 'esb-test.corp',
  username: 'integrator',
  ...patch,
})

describe('список стендов в файле', () => {
  const prod = stand({
    name: 'Продуктив',
    environment: 'prod',
    url: 'esb.corp',
    password: 'secret',
    rememberPassword: true,
    lastUsedAt: '2026-09-27T10:00:00Z',
    broker: { ...blankBroker(), port: '5671', password: 'amqp-secret', clientKeyPassphrase: 'key-secret', queue: 'IN' },
  })

  it('пароли, идентификаторы и время подключения в файл не попадают', () => {
    const text = exportStands([prod], '2026-09-28T09:00:00Z')
    expect(text).not.toContain('secret')
    expect(text).not.toContain(prod.id)
    expect(text).not.toContain('lastUsedAt')
    const file = JSON.parse(text)
    expect(file.format).toBe('fesb-toolkit/stands')
    expect(file.stands[0]).toMatchObject({ name: 'Продуктив', environment: 'prod', url: 'esb.corp', username: 'integrator' })
    expect(file.stands[0].broker).toMatchObject({ port: '5671', queue: 'IN' })
  })

  it('файл читается обратно тем же стендом, но без паролей и с новым идентификатором', () => {
    const [back] = parseStands(exportStands([prod], '2026-09-28T09:00:00Z'))
    expect(back).toMatchObject({ name: 'Продуктив', environment: 'prod', url: 'esb.corp', port: prod.port, username: 'integrator' })
    expect(back.id).not.toBe(prod.id)
    expect(back.password).toBe('')
    expect(back.rememberPassword).toBe(false)
    expect(back.broker.password).toBe('')
    expect(back.broker.queue).toBe('IN')
  })

  it('вписанный в файл руками пароль не берётся', () => {
    const text = JSON.stringify({
      format: 'fesb-toolkit/stands', version: 1,
      stands: [{ name: 'Тест', url: 'esb-test.corp', username: 'u', password: 'typed', rememberPassword: true, broker: { password: 'typed' } }],
    })
    const [back] = parseStands(text)
    expect(back.password).toBe('')
    expect(back.broker.password).toBe('')
  })

  it('чужой файл объясняется, а не молча даёт пустой список', () => {
    const reason = (text: string) => {
      try { parseStands(text); return null } catch (err) { return (err as StandsFileProblem).reason }
    }
    expect(reason('{ broken')).toBe('notJson')
    expect(reason('{"profiles": []}')).toBe('notStands')
    expect(reason('{"format": "fesb-toolkit/stands", "version": 9, "stands": []}')).toBe('newerVersion')
    expect(reason('{"format": "fesb-toolkit/stands", "version": 1, "stands": [{"name": "без адреса"}]}')).toBe('empty')
  })

  it('уже известный стенд узнаётся по адресу и пользователю и не перезаписывается', () => {
    const mine = stand({ name: 'Мой тест', url: 'ESB-TEST.corp', password: 'mine', rememberPassword: true })
    const store = { ...EMPTY_STORE, profiles: [mine] }
    const incoming = parseStands(exportStands([
      stand({ name: 'Тест' }),
      stand({ name: 'Тест, дубль' }),
      stand({ name: 'Другой пользователь', username: 'admin' }),
    ], '2026-09-28T09:00:00Z'))

    const items = planImport(store, incoming)
    expect(items.map((item) => [item.profile.name, item.status, item.existingName])).toEqual([
      ['Тест', 'exists', 'Мой тест'],
      ['Другой пользователь', 'new', null],
    ])

    const next = applyImport(store, items)
    expect(next.profiles.map((profile) => profile.name)).toEqual(['Мой тест', 'Другой пользователь'])
    expect(next.profiles[0].password).toBe('mine')
  })

  it('имя файла — с датой', () => {
    expect(standsFileName(new Date(2026, 8, 3))).toBe('fesb-stands-2026-09-03.json')
  })
})
