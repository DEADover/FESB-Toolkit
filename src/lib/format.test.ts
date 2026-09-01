import { describe, expect, it } from 'vitest'

import { formatBytes, formatEta, formatShare, formatUptime } from './format'
import { folderBesideExport, localStamp, localTime } from './paths'

describe('formatBytes', () => {
  it('оставляет байты байтами, пока их немного', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('переходит к следующей единице ровно на границе', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB')
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB')
  })

  it('от сотни знак после запятой не нужен — он уже ничего не уточняет', () => {
    expect(formatBytes(150 * 1024)).toBe('150 KB')
    expect(formatBytes(99 * 1024)).toBe('99.0 KB')
  })

  it('не уходит за самую крупную единицу', () => {
    // Больше терабайта дисков у шины не бывает, но и ломаться на них незачем.
    expect(formatBytes(5 * 1024 ** 5)).toMatch(/TB$/)
  })
})

describe('formatUptime', () => {
  // Настоящий словарь здесь не нужен: проверяется выбор единиц, а не перевод.
  const t = (key: 'server.days' | 'server.hours' | 'server.minutes', values: { count: number }) =>
    `${values.count}${{ 'server.days': 'д', 'server.hours': 'ч', 'server.minutes': 'м' }[key]}`

  it('показывает две крупнейшие единицы', () => {
    expect(formatUptime(2 * 86_400_000 + 19 * 3_600_000, t)).toBe('2д 19ч')
    expect(formatUptime(3 * 3_600_000 + 25 * 60_000, t)).toBe('3ч 25м')
    expect(formatUptime(7 * 60_000, t)).toBe('7м')
  })

  it('не теряет ноль во второй единице', () => {
    // «2д 0ч» честнее, чем «2д»: иначе кажется, что счёт ровный.
    expect(formatUptime(2 * 86_400_000, t)).toBe('2д 0ч')
  })

  it('короткий срок — это ноль минут, а не пустая строка', () => {
    expect(formatUptime(0, t)).toBe('0м')
    expect(formatUptime(30_000, t)).toBe('0м')
  })
})

describe('formatShare', () => {
  it('округляет долю до целых процентов', () => {
    expect(formatShare(0)).toBe('0%')
    expect(formatShare(0.2)).toBe('20%')
    expect(formatShare(0.005)).toBe('1%')
    expect(formatShare(1)).toBe('100%')
  })
})

describe('localStamp и localTime', () => {
  it('метка архива годится для имени файла', () => {
    expect(localStamp()).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}$/)
  })

  it('время истории идёт тем же порядком, что у сервера', () => {
    // Сортировка истории отчётов строковая, поэтому порядок частей важен.
    expect(localTime()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
  })
})

describe('folderBesideExport', () => {
  it('кладёт архив рядом с папкой конфигурации', () => {
    expect(folderBesideExport('/home/user/config-2026')).toBe('/home/user/')
  })

  it('поднимается на уровень выше от папки domains', () => {
    expect(folderBesideExport('/home/user/config-2026/domains')).toBe('/home/user/')
  })

  it('от архива — в ту же папку, где он лежит', () => {
    expect(folderBesideExport('/home/user/config.zip')).toBe('/home/user/')
  })

  it('понимает пути Windows', () => {
    expect(folderBesideExport('C:\\configs\\export\\domains')).toBe('C:\\configs\\')
  })
})

describe('formatEta', () => {
  // Настоящий словарь здесь не нужен: проверяется расчёт, а не перевод.
  const t = (key: 'job.eta.seconds' | 'job.eta.minutes', values: { count: number }) =>
    `${values.count}${key === 'job.eta.seconds' ? 'с' : 'мин'}`

  it('считает остаток по тому, сколько уже прошло', () => {
    // 10 из 100 за 8 секунд — значит впереди ещё семьдесят с небольшим.
    expect(formatEta(8_000, 10, 100, t)).toBe('70с')
    expect(formatEta(60_000, 50, 200, t)).toBe('3мин')
  })

  it('от полутора минут считает в минутах: секунды там уже не читают', () => {
    expect(formatEta(8_900, 10, 100, t)).toBe('80с')
    expect(formatEta(10_000, 10, 100, t)).toBe('2мин')
  })

  it('молчит, пока сделано слишком мало', () => {
    // На первых процентах оценка врёт сильнее, чем помогает.
    expect(formatEta(1_000, 5, 100, t)).toBeNull()
  })

  it('молчит, когда ждать почти нечего', () => {
    expect(formatEta(10_000, 90, 100, t)).toBeNull()
    expect(formatEta(10_000, 100, 100, t)).toBeNull()
  })

  it('не делит на ноль и не гадает без объёма', () => {
    expect(formatEta(10_000, 0, 100, t)).toBeNull()
    expect(formatEta(10_000, 5, 0, t)).toBeNull()
  })

  it('округляет до пятёрки секунд: точнее оценка всё равно не бывает', () => {
    expect(formatEta(10_000, 20, 100, t)).toBe('40с')
    expect(formatEta(11_000, 20, 100, t)).toBe('45с')
  })
})
