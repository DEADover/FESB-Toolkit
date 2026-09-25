import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { FlowArrow, Gear, House, Plugs, Queue, SlidersHorizontal, Stack, type Icon } from '@phosphor-icons/react'

import { useI18n, type MessageKey } from '../i18n'
import { apiDomains, apiPropertiesSweep, apiQueueManagers, apiQueues, apiRoutesOverview } from '../lib/api'
import { buildIndex, MIN_QUERY, searchIndex, type Focus, type IndexEntry, type IndexKind } from '../lib/standIndex'
import type { Connection } from '../types'
import { byEnvironment, type ConnectionProfile, type ConnectionStore } from '../lib/connection'
import { API_GROUPS, FILE_SCREENS, sortByLabel, type ScreenId } from './Sidebar'
import { Badge, cx, FOCUS_RING, Modal, SearchInput, Spinner } from './ui'
import { ENVIRONMENT_LABEL, ENVIRONMENT_TONE } from './HeaderBar'

interface Props {
  open: boolean
  onClose: () => void
  store: ConnectionStore
  onScreen: (screen: ScreenId) => void
  /** Открытое подключение: по нему ищется содержимое стенда. */
  connection: Connection | null
  /** Переход к найденному на стенде — экран откроется уже на нём. */
  onFocus: (focus: Focus) => void
  onConnect: (profile: ConnectionProfile) => void
  onConfigure: (profileId: string | null) => void
}

/** Строка списка: куда перейти или к чему подключиться. */
interface Command {
  id: string
  label: string
  /** Раздел, в котором лежит пункт: «API», «Файлы конфигурации», «Стенды». */
  group: string
  icon: Icon
  /** Где лежит найденное на стенде: домен, менеджер, уровень константы. */
  detail?: string
  badge?: ReactNode
  run: () => void
}

const KIND: Record<IndexKind, { icon: Icon; group: MessageKey }> = {
  domain: { icon: Stack, group: 'nav.api.domains' },
  route: { icon: FlowArrow, group: 'nav.api.routes' },
  constant: { icon: SlidersHorizontal, group: 'nav.api.properties' },
  queue: { icon: Queue, group: 'nav.api.queues' },
}

/**
 * Указатель стенда живёт, пока палитру открывают и закрывают: читать его
 * заново на каждое нажатие ⌘K незачем, а через пять минут он уже мог
 * устареть — тогда перечитывается при следующем открытии.
 */
const INDEX_TTL = 5 * 60_000
const indexCache = new Map<string, { at: number; entries: IndexEntry[] }>()

async function loadIndex(connection: Connection, labels: { application: string; broker: string }): Promise<IndexEntry[]> {
  // Каждый источник — сам по себе: нет прав на очереди — ищем по остальному.
  const safe = <T,>(promise: Promise<T>, fallback: T) => promise.catch(() => fallback)
  const [domains, routes, constants, managers] = await Promise.all([
    safe(apiDomains(connection), []),
    safe(apiRoutesOverview(connection), []),
    safe(apiPropertiesSweep(connection), []),
    safe(apiQueueManagers(connection), []),
  ])
  const queues = await Promise.all(managers.filter((manager) => manager.running).map(async (manager) => ({
    manager,
    queues: await safe(apiQueues(connection, manager.kind, manager.id), []),
  })))
  return buildIndex({ domains, routes, constants, queues }, labels)
}

/** Указатель открытого стенда: из памяти, если свежий, иначе читается заново. */
function useStandIndex(open: boolean, connection: Connection | null) {
  const { t } = useI18n()
  const key = connection ? `${connection.url}\n${connection.username}` : null
  const [entries, setEntries] = useState<IndexEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const application = t('properties.scope.application')
  const broker = t('properties.scope.broker')

  useEffect(() => {
    if (!open || !connection || !key) {
      if (!connection) setEntries(null)
      return
    }
    const cached = indexCache.get(key)
    if (cached) setEntries(cached.entries)
    if (cached && Date.now() - cached.at < INDEX_TTL) return
    let alive = true
    setLoading(true)
    loadIndex(connection, { application, broker })
      .then((fresh) => {
        indexCache.set(key, { at: Date.now(), entries: fresh })
        if (alive) setEntries(fresh)
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, connection, key, application, broker])

  return { entries, loading }
}

/**
 * Переход по разделам с клавиатуры.
 *
 * Разделов стало шестнадцать, и мышью до нужного добираются дольше, чем
 * набирают его имя. Здесь же стенды: переключиться на другой сервер —
 * то же перемещение, только не по экранам.
 *
 * Ищет по видимой подписи, а не по коду раздела: человек помнит, как пункт
 * называется, а не как он называется внутри.
 */
export function CommandPalette({ open, onClose, store, onScreen, connection, onFocus, onConnect, onConfigure }: Props) {
  const { t, language } = useI18n()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Каждый вызов начинается с чистого поля: палитру открывают, чтобы
  // куда-то попасть, а не чтобы вспомнить прошлый запрос.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
    }
  }, [open])

  const commands = useMemo<Command[]>(() => {
    const screens: Command[] = [
      { id: 'welcome', label: t('nav.welcome'), group: '', icon: House, run: () => onScreen('welcome') },
      ...sortByLabel(FILE_SCREENS, (entry) => t(entry.label), language).map((entry) => ({
        id: entry.id,
        label: t(entry.title ?? entry.label),
        group: t('nav.files'),
        icon: entry.icon,
        run: () => onScreen(entry.id),
      })),
      {
        id: 'connection',
        label: t('nav.connection'),
        group: `${t('nav.api')} · ${t('nav.api.general')}`,
        icon: Gear,
        run: () => onScreen('connection'),
      },
      ...API_GROUPS.flatMap((group) =>
        sortByLabel(group.items, (entry) => t(entry.label), language).map((entry) => ({
          id: entry.id,
          label: t(entry.title ?? entry.label),
          group: `${t('nav.api')} · ${t(group.title)}`,
          icon: entry.icon,
          run: () => onScreen(entry.id),
        })),
      ),
    ]

    const stands: Command[] = byEnvironment(store.profiles).flatMap(([, profiles]) =>
      profiles.map((profile) => ({
        id: `stand:${profile.id}`,
        label: profile.name,
        group: t('welcome.stands'),
        icon: Plugs,
        badge: (
          <span className={cx('shrink-0 rounded border px-1 text-[10px]', ENVIRONMENT_TONE[profile.environment])}>
            {t(ENVIRONMENT_LABEL[profile.environment])}
          </span>
        ),
        // Без сохранённого пароля подключиться молча нельзя — ведём туда,
        // где его спросят. Тот же выбор, что и у переключателя в шапке.
        run: () =>
          profile.rememberPassword && profile.password.length > 0
            ? onConnect(profile)
            : onConfigure(profile.id),
      })),
    )

    return [...screens, ...stands]
  }, [t, language, store, onScreen, onConnect, onConfigure])

  const index = useStandIndex(open, connection)

  const found = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return commands
    const direct = commands.filter(
      (item) => item.label.toLowerCase().includes(needle) || item.group.toLowerCase().includes(needle),
    )
    // Содержимое стенда — после разделов и стендов: чаще всего ⌘K жмут,
    // чтобы перейти в раздел, и найденное на стенде не должно его вытеснять.
    const onStand = searchIndex(index.entries ?? [], needle).map((entry, position): Command => ({
      id: `stand:${entry.kind}:${position}:${entry.label}`,
      label: entry.label,
      detail: entry.where,
      group: t(KIND[entry.kind].group),
      icon: KIND[entry.kind].icon,
      run: () => onFocus(entry.focus),
    }))
    return [...direct, ...onStand]
  }, [commands, query, index.entries, onFocus, t])
  const searchingStand = index.loading && query.trim().length >= MIN_QUERY

  // Список сузился — выделение не должно оставаться за его краем.
  const current = Math.min(active, Math.max(found.length - 1, 0))

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [current, found])

  const choose = (item: Command | undefined) => {
    if (!item) return
    onClose()
    item.run()
  }

  return (
    <Modal open={open} onClose={onClose} closeLabel={t('action.close')} title={t('palette.title')}>
      <div
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setActive((value) => Math.min(value + 1, found.length - 1))
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActive((value) => Math.max(value - 1, 0))
          }
          if (event.key === 'Enter') {
            event.preventDefault()
            choose(found[current])
          }
        }}
      >
        <SearchInput
          autoFocus
          value={query}
          placeholder={t('palette.search')}
          onChange={(value) => { setQuery(value); setActive(0) }}
          clearLabel={t('action.clearSearch')}
        />

        <div ref={listRef} className="mt-3 max-h-80 overflow-y-auto">
          {found.map((item, index) => (
            <button
              key={item.id}
              type="button"
              data-active={index === current}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(item)}
              className={cx(
                'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition',
                FOCUS_RING,
                index === current ? 'bg-accent/12' : 'hover:bg-surface-3',
              )}
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface-2 text-content-subtle">
                <item.icon size={15} weight="regular" />
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px]">
                {item.label}
                {item.detail && <span className="ml-2 text-[11px] text-content-subtle">{item.detail}</span>}
              </span>
              {item.badge}
              {item.group && <span className="shrink-0 text-[10.5px] text-content-subtle">{item.group}</span>}
            </button>
          ))}

          {searchingStand && (
            <p className="flex items-center gap-2 px-2.5 py-2 text-[11.5px] text-content-subtle">
              <Spinner className="size-3" /> {t('palette.indexing')}
            </p>
          )}

          {found.length === 0 && !searchingStand && (
            <p className="py-8 text-center text-[12px] text-content-subtle">{t('palette.nothing')}</p>
          )}
        </div>

        <p className="mt-3 text-[11px] text-content-subtle">
          <Badge>↑ ↓</Badge> {t('palette.move')} · <Badge>↵</Badge> {t('palette.pick')} · <Badge>Esc</Badge> {t('action.close')}
        </p>
      </div>
    </Modal>
  )
}
