// Чтение сводки по стенду: шесть запросов разом, каждый сам по себе.
// Нужна и карточке на «Начале», и фоновой проверке, поэтому живёт отдельно.

import {
  apiCertificates, apiDomainStatistics, apiInflight, apiModules, apiQueueManagers, apiQueues, apiRoutesOverview, errorText,
} from './api'
import { buildHealth, type HealthCheck, type Loaded, type QueueSnapshot } from './health'
import type { Connection } from '../types'

async function settle<T>(promise: Promise<T>): Promise<Loaded<T>> {
  try {
    return { data: await promise }
  } catch (err) {
    return { error: errorText(err) }
  }
}

/** Очереди — по каждому запущенному менеджеру; у остановленного спрашивать нечего. */
async function loadQueues(connection: Connection): Promise<QueueSnapshot[]> {
  const managers = await apiQueueManagers(connection)
  return Promise.all(managers.map(async (manager) => ({
    manager,
    queues: manager.running
      ? await settle(apiQueues(connection, manager.kind, manager.id))
      : { error: 'stopped' },
  })))
}

export async function loadHealth(connection: Connection): Promise<HealthCheck[]> {
  const [domains, routes, certificates, inflight, modules, queues] = await Promise.all([
    settle(apiDomainStatistics(connection)),
    settle(apiRoutesOverview(connection)),
    settle(apiCertificates(connection)),
    settle(apiInflight(connection)),
    settle(apiModules(connection)),
    settle(loadQueues(connection)),
  ])
  return buildHealth({ domains, routes, certificates, inflight, modules, queues, now: new Date() })
}
