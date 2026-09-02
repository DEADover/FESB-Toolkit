import { invoke } from '@tauri-apps/api/core'

import type { ConnectionProfile } from './connection'
import type { Profile } from '../amqpush/types'

/**
 * Брокер стенда: из профиля — в то, что понимает раздел AMQP.
 *
 * Приложение работает со стендом целиком, поэтому подключение к шине
 * и к её брокеру — один профиль. Незаполненные поля брокера берутся
 * у шины: узел и учётные данные почти всегда те же, и заставлять
 * набирать их второй раз незачем.
 */

/** Узел шины без схемы и пути: `https://esb.corp:8181/manager` → `esb.corp`. */
export function busHost(url: string): string {
  const trimmed = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const withoutPath = trimmed.split('/')[0] ?? ''
  // Порт шины брокеру не подходит — у него свой.
  const withoutPort = withoutPath.replace(/:\d+$/, '')
  return withoutPort
}

/**
 * Профиль стенда в виде, который принимает движок AMQP.
 *
 * Имя профиля берётся у стенда: в разделе AMQP видно тот же стенд, что
 * выбран в шапке, и статистика раскладывается по тем же именам.
 */
export function brokerProfile(profile: ConnectionProfile): Profile {
  const broker = profile.broker
  const number = (value: string, fallback: number) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  return {
    name: profile.name,
    host: broker.host.trim() || busHost(profile.url),
    port: number(broker.port, 5672),
    username: broker.saslAnonymous ? '' : (broker.username.trim() || profile.username),
    password: broker.saslAnonymous ? '' : (broker.password || profile.password),
    queue: broker.queue.trim(),
    use_tls: broker.useTls,
    container_id: broker.containerId.trim() || undefined,
    heartbeat_secs: number(broker.heartbeatSecs, 0),
    connect_timeout_secs: number(broker.connectTimeoutSecs, 10),
    tls_skip_verify: broker.tlsSkipVerify,
    sasl_anonymous: broker.saslAnonymous,
    workspace: profile.environment,
    reconnect_base_ms: number(broker.reconnectBaseMs, 1000),
    reconnect_max_ms: number(broker.reconnectMaxMs, 30000),
    reconnect_multiplier: number(broker.reconnectMultiplier, 2),
    send_retry_attempts: Math.max(1, Math.floor(number(broker.sendRetryAttempts, 1))),
    send_retry_delay_ms: number(broker.sendRetryDelayMs, 250),
    client_cert_path: broker.clientCertPath.trim() || undefined,
    client_key_path: broker.clientKeyPath.trim() || undefined,
    client_key_passphrase: broker.clientKeyPassphrase || undefined,
    use_ws: broker.useWs,
    ws_path: broker.wsPath.trim() || undefined,
  }
}

/** Профиль, у которого есть куда подключаться: без узла брокер бесполезен. */
export function hasBroker(profile: ConnectionProfile): boolean {
  return (profile.broker.host.trim() || busHost(profile.url)).length > 0
}

/** Что ответила проверка брокера. */
export interface BrokerProbe {
  /** Куда достучались: `host:port`. */
  endpoint: string
  /** Сколько заняло рукопожатие вместе с входом, мс. */
  connectMs: number
  /** Как брокер себя назвал, если ответил на управляющий запрос. */
  brokerName: string | null
  /** Почему имени нет: управление могло быть закрыто правами. */
  note: string | null
}

/**
 * Проверка брокера стенда.
 *
 * Идёт своим, отдельным соединением: проверяют обычно правку настроек или
 * соседний стенд, и рвать ради этого живого подписчика раздела нельзя.
 */
export function probeBroker(profile: ConnectionProfile): Promise<BrokerProbe> {
  return invoke<BrokerProbe>('probe_broker', { profile: brokerProfile(profile) })
}
