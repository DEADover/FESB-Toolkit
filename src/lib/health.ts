// Сводка по стенду: что на нём сейчас не так.
//
// Всё, что здесь собирается, приложение и так умеет показать — но на шести
// разных экранах. Сводка отвечает на один вопрос «надо ли куда-то идти» и
// ведёт туда, где проблему лечат. Сама по себе она ничего не запрашивает:
// ответы API приходят снаружи, здесь только правила.

import type { ScreenId } from '../components/Sidebar'
import type {
  CertificateReport, DomainStat, InflightExchange, ModuleRow, QueueManager, QueueRow, RouteSummary,
} from '../types'

/**
 * Обмен дольше минуты считается зависшим — и в сводке, и на экране «Обмены».
 *
 * Минута выбрана не по красоте: обычный обмен укладывается в сотни
 * миллисекунд, и всё, что живёт дольше минуты, либо ждёт чужую систему,
 * либо уже никого не дождётся.
 */
export const SLOW_MS = 60_000
/** Сертификат, которому осталось меньше месяца, пора менять. */
export const CERT_URGENT_DAYS = 30
/** Столько сообщений в очереди — уже повод посмотреть, даже если её читают. */
export const DEEP_QUEUE = 1000

export type HealthId = 'domains' | 'routes' | 'certificates' | 'inflight' | 'modules' | 'queues'
export type HealthLevel = 'ok' | 'warn' | 'error' | 'unknown'

export interface HealthCheck {
  id: HealthId
  level: HealthLevel
  /** Сколько найдено — для подписи. У `ok` и `unknown` ноль. */
  count: number
  /** Несколько имён для примера, самые важные первыми. */
  samples: string[]
  /** Всё найденное — по нему фоновая проверка узнаёт новое. */
  items: string[]
  screen: ScreenId
  /** Текст ошибки, если данные получить не удалось. */
  error?: string
}

/** Ответ одного запроса: данные или текст ошибки. */
export type Loaded<T> = { data: T } | { error: string }

export interface QueueSnapshot {
  manager: QueueManager
  /** Очереди запущенного менеджера; у остановленного — пусто. */
  queues: Loaded<QueueRow[]>
}

export interface HealthInput {
  domains: Loaded<DomainStat[]>
  routes: Loaded<RouteSummary[]>
  certificates: Loaded<CertificateReport>
  inflight: Loaded<InflightExchange[]>
  modules: Loaded<ModuleRow[]>
  queues: Loaded<QueueSnapshot[]>
  /** Текущее время — снаружи, чтобы правила проверялись тестами. */
  now: Date
}

const SAMPLE = 3

function unknown(id: HealthId, screen: ScreenId, error: string): HealthCheck {
  return { id, level: 'unknown', count: 0, samples: [], items: [], screen, error }
}

function found(id: HealthId, screen: ScreenId, level: 'warn' | 'error', names: string[]): HealthCheck {
  if (names.length === 0) return { id, level: 'ok', count: 0, samples: [], items: [], screen }
  return { id, level, count: names.length, samples: names.slice(0, SAMPLE), items: names, screen }
}

/** Дней до конца срока; отрицательное — уже истёк. */
export function daysLeft(notAfter: string, now: Date): number | null {
  const end = Date.parse(notAfter)
  if (Number.isNaN(end)) return null
  return Math.floor((end - now.getTime()) / 86_400_000)
}

export function checkDomains(input: Loaded<DomainStat[]>): HealthCheck {
  if ('error' in input) return unknown('domains', 'api.domains', input.error)
  const stopped = input.data.filter((domain) => !domain.active).map((domain) => domain.name)
  return found('domains', 'api.domains', 'warn', stopped.sort((a, b) => a.localeCompare(b)))
}

/**
 * СОПС с ошибками — только в запущенных доменах: у остановленного домена
 * счётчики — история, и чинить там нечего, пока его не запустят.
 * Больше всего ошибок — первыми.
 */
export function checkRoutes(input: Loaded<RouteSummary[]>): HealthCheck {
  if ('error' in input) return unknown('routes', 'api.routes', input.error)
  const failing = input.data
    .filter((route) => route.failed > 0 && route.state === 'Started')
    .sort((a, b) => b.failed - a.failed)
    .map((route) => `${route.name} (${route.domain})`)
  return found('routes', 'api.routes', 'error', failing)
}

/** Истёкшие — первыми и как ошибка; истекающие в течение месяца — предупреждение. */
export function checkCertificates(input: Loaded<CertificateReport>, now: Date): HealthCheck {
  if ('error' in input) return unknown('certificates', 'api.certificates', input.error)
  const due = input.data.certificates
    .map((cert) => ({ cert, left: daysLeft(cert.notAfter, now) }))
    .filter((row): row is { cert: typeof row.cert; left: number } => row.left !== null && row.left <= CERT_URGENT_DAYS)
    .sort((a, b) => a.left - b.left)
  const check = found('certificates', 'api.certificates', 'warn', due.map((row) => row.cert.alias))
  if (due.some((row) => row.left < 0)) check.level = 'error'
  return check
}

export function checkInflight(input: Loaded<InflightExchange[]>): HealthCheck {
  if ('error' in input) return unknown('inflight', 'api.inflight', input.error)
  const stuck = input.data
    .filter((row) => (row.duration ?? 0) >= SLOW_MS)
    .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
    .map((row) => `${row.route} (${row.domain})`)
  return found('inflight', 'api.inflight', 'warn', stuck)
}

/**
 * Модуль включён, но не работает, — ошибка. Ждёт перезапуска — предупреждение:
 * работает, но со старой конфигурацией.
 */
export function checkModules(input: Loaded<ModuleRow[]>): HealthCheck {
  if ('error' in input) return unknown('modules', 'api.modules', input.error)
  const down = input.data.filter((module) => module.active && !module.running)
  const stale = input.data.filter((module) => module.running && (module.awaitRestart || module.awaitSystemRestart))
  const check = found('modules', 'api.modules', down.length > 0 ? 'error' : 'warn', [...down, ...stale].map((module) => module.label || module.name))
  return check
}

/**
 * Менеджер с автозапуском, который стоит, — ошибка. Очередь, где сообщения
 * лежат, а читателей нет, или где их набралось больше тысячи, —
 * предупреждение. Служебные очереди менеджера не в счёт.
 */
export function checkQueues(input: Loaded<QueueSnapshot[]>): HealthCheck {
  if ('error' in input) return unknown('queues', 'api.queues', input.error)
  const stopped: string[] = []
  const deep: Array<{ name: string; messages: number }> = []
  for (const { manager, queues } of input.data) {
    if (!manager.running) {
      if (manager.autoStart) stopped.push(manager.broker)
      continue
    }
    if ('error' in queues) continue
    for (const queue of queues.data) {
      if (queue.internal) continue
      if (queue.messages >= DEEP_QUEUE || (queue.messages > 0 && queue.consumers === 0)) {
        deep.push({ name: `${queue.name} (${manager.id})`, messages: queue.messages })
      }
    }
  }
  deep.sort((a, b) => b.messages - a.messages)
  return found('queues', 'api.queues', stopped.length > 0 ? 'error' : 'warn', [...stopped, ...deep.map((row) => row.name)])
}

const SEVERITY: Record<HealthLevel, number> = { error: 0, warn: 1, unknown: 2, ok: 3 }

/**
 * Строки сводки — сначала найденное, от тяжёлого к лёгкому, потом то, что
 * в порядке. При равной тяжести порядок постоянный: модули первыми, потому
 * что без них не работает всё остальное.
 */
export function buildHealth(input: HealthInput): HealthCheck[] {
  const checks = [
    checkModules(input.modules),
    checkDomains(input.domains),
    checkRoutes(input.routes),
    checkInflight(input.inflight),
    checkQueues(input.queues),
    checkCertificates(input.certificates, input.now),
  ]
  return checks
    .map((check, index) => ({ check, index }))
    .sort((a, b) => SEVERITY[a.check.level] - SEVERITY[b.check.level] || a.index - b.index)
    .map(({ check }) => check)
}

/** Самое тяжёлое из найденного — для заголовка сводки. */
export function worstLevel(checks: HealthCheck[]): HealthLevel {
  const order: HealthLevel[] = ['error', 'warn', 'unknown', 'ok']
  for (const level of order) if (checks.some((check) => check.level === level)) return level
  return 'ok'
}
