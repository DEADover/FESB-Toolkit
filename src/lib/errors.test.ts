import { describe, expect, it } from 'vitest'

import { errorText, readable } from './errors'

/**
 * Вне React словарь стоит на английском — на нём и проверяем.
 * Русский текст читается тем же путём, просто из другого словаря.
 */
describe('readable', () => {
  it('переводит знакомый код и оставляет подробность как есть', () => {
    const raw = JSON.stringify({
      code: 'transport.unreachable',
      detail: 'https://esb.corp/manager — failed to lookup address information',
    })
    expect(readable(raw)).toBe(
      'Cannot reach the server: https://esb.corp/manager — failed to lookup address information',
    )
  })

  it('без подробности показывает один перевод', () => {
    expect(readable(JSON.stringify({ code: 'server.silent', detail: '' }))).toBe('The server did not answer')
  })

  it('незнакомый код — не повод показать JSON: полезнее подробность', () => {
    const raw = JSON.stringify({ code: 'что.то.новое', detail: 'connection reset by peer' })
    expect(readable(raw)).toBe('connection reset by peer')
  })

  it('незнакомый код без подробности показывается как есть — врать нечем', () => {
    const raw = JSON.stringify({ code: 'что.то.новое', detail: '' })
    expect(readable(raw)).toBe(raw)
  })

  it('обычный текст остаётся обычным текстом', () => {
    expect(readable('Cannot create the file: permission denied')).toBe('Cannot create the file: permission denied')
  })

  it('сломанный JSON не роняет разбор', () => {
    expect(readable('{ это не json')).toBe('{ это не json')
  })

  it('JSON без кода показывается как есть', () => {
    const raw = JSON.stringify({ detail: 'что-то' })
    expect(readable(raw)).toBe(raw)
  })

  it('JSON, который оказался не объектом, тоже переживается', () => {
    expect(readable('{}')).toBe('{}')
  })
})

describe('errorText', () => {
  it('принимает строку, ошибку и что угодно ещё', () => {
    expect(errorText('просто строка')).toBe('просто строка')
    expect(errorText(new Error(JSON.stringify({ code: 'auth.failed', detail: '' })))).toBe(
      'Sign-in failed: check the user name and password',
    )
    expect(errorText({ странное: true })).toBe('{"странное":true}')
  })
})
