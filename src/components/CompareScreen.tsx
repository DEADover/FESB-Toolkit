import { useCallback, useEffect, useMemo, useState } from 'react'

import { ArrowRight, ArrowsLeftRight, Camera, Trash } from '@phosphor-icons/react'

import { useI18n, type MessageKey } from '../i18n'
import { apiCompareStands, errorText, snapshotCompare, snapshotDelete, snapshotList, snapshotTake } from '../lib/api'
import { localTime } from '../lib/paths'
import { connectionWith, type ConnectionStore } from '../lib/connection'
import type { Comparison, Connection, ServerInfo, Side, SnapshotEntry } from '../types'
import { ErrorBar, NotConnected, Panel, ScreenBody, StatsBar, TableMessage } from './ApiShell'
import {
  Badge, Button, ButtonGlyph, cx, DataTable, IconButton, Readout, SearchInput, Segmented, Select, Th, THead, TextInput,
} from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  store: ConnectionStore
  activeProfileId: string | null
  onGoToConnection: () => void
}

type Part = 'domains' | 'routes' | 'properties'

/** С чем сравнивается открытый стенд: с другим стендом или с самим собой в прошлом. */
type Mode = 'stands' | 'time'

/** Значение списка «Стало», означающее стенд сейчас, а не снимок. */
const NOW = ''

/**
 * Чем один стенд отличается от другого.
 *
 * Перед каждым релизом кто-нибудь спрашивает, что на тесте не так, как
 * на продуктиве, и до сих пор на это отвечали двумя окнами браузера и памятью.
 * Стенд рассказывает о себе тремя дешёвыми запросами, поэтому сравнение
 * ничего не выгружает и ничего не пишет: только читает оба.
 *
 * Слева всегда открытый стенд — тот, с которым идёт работа. Справа любой
 * из сохранённых: пароль спрашивается здесь же, если он не запомнен.
 */
export function CompareScreen({ connection, server, store, activeProfileId, onGoToConnection }: Props) {
  const { t } = useI18n()
  const [otherId, setOtherId] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [part, setPart] = useState<Part>('properties')
  const [side, setSide] = useState<Side | 'all'>('all')
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<Comparison | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('stands')
  const [snapshots, setSnapshots] = useState<SnapshotEntry[]>([])
  const [before, setBefore] = useState<string | null>(null)
  const [after, setAfter] = useState<string>(NOW)
  const [label, setLabel] = useState('')
  const [taking, setTaking] = useState(false)

  /** Снимки только этого стенда: чужие с ним сравнивать — это режим «Два стенда». */
  const mine = useMemo(
    () => snapshots.filter((entry) => entry.server === server?.baseUrl),
    [snapshots, server?.baseUrl],
  )

  useEffect(() => {
    snapshotList().then(setSnapshots).catch(() => setSnapshots([]))
  }, [])

  // «Было» по умолчанию — последний снимок: чаще всего спрашивают, что
  // поменялось с него.
  useEffect(() => {
    setBefore((prev) => (prev && mine.some((entry) => entry.id === prev) ? prev : mine[0]?.id ?? null))
    setAfter((prev) => (prev === NOW || mine.some((entry) => entry.id === prev) ? prev : NOW))
  }, [mine])

  const take = useCallback(async () => {
    if (!connection) return
    setTaking(true)
    setError(null)
    try {
      const list = await snapshotTake(connection, localTime(), label)
      setSnapshots(list)
      setLabel('')
      const fresh = list.find((entry) => entry.server === server?.baseUrl)
      if (fresh) setBefore(fresh.id)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setTaking(false)
    }
  }, [connection, label, server?.baseUrl])

  const remove = useCallback(async (id: string) => {
    try {
      setSnapshots(await snapshotDelete(id))
      setResult(null)
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  const runTime = useCallback(async () => {
    if (!before) return
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      setResult(await snapshotCompare(before, after === NOW ? null : after, after === NOW ? connection : null))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setRunning(false)
    }
  }, [before, after, connection])

  /** Подпись снимка в списке: время, а если есть — и подпись человека. */
  const snapshotLabel = (entry: SnapshotEntry) =>
    `${entry.takenAt.replace('T', ' ').slice(0, 16)}${entry.label ? ` · ${entry.label}` : ''}`
  const sideLabel = (value: Side) => t((mode === 'time' ? TIME_LABEL : SIDE_LABEL)[value])

  /** Сравнивать стенд с самим собой незачем, поэтому открытый в список не идёт. */
  const others = useMemo(
    () => store.profiles.filter((profile) => profile.id !== activeProfileId),
    [store.profiles, activeProfileId],
  )
  const other = others.find((profile) => profile.id === otherId) ?? null
  const needsPassword = other !== null && !other.rememberPassword && !password

  const run = useCallback(async () => {
    if (!connection || !other) return
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      setResult(await apiCompareStands(connection, connectionWith(other, password)))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setRunning(false)
    }
  }, [connection, other, password])

  const rows = useMemo(() => {
    if (!result) return []
    const all = result[part]
    const needle = query.trim().toLowerCase()
    return all.filter((row) => {
      if (side !== 'all' && row.side !== side) return false
      if (!needle) return true
      return (
        row.scope.toLowerCase().includes(needle) ||
        row.name.toLowerCase().includes(needle) ||
        (row.left ?? '').toLowerCase().includes(needle) ||
        (row.right ?? '').toLowerCase().includes(needle)
      )
    })
  }, [result, part, side, query])

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  return (
    <ScreenBody>
      <StatsBar>
        {result ? (
          <>
            <Readout label={t('compare.domains')} value={String(result.domains.length)} tone={result.domains.length > 0 ? 'warn' : undefined} />
            <Readout label={t('compare.routes')} value={String(result.routes.length)} tone={result.routes.length > 0 ? 'warn' : undefined} />
            <Readout label={t('compare.properties')} value={String(result.properties.length)} tone={result.properties.length > 0 ? 'warn' : undefined} />
            <Readout
              label={t('compare.read')}
              value={`${result.left.routes} / ${result.right.routes}`}
              hint={t('compare.read.hint')}
            />
          </>
        ) : (
          <span className="text-[12px] text-content-muted">{t(mode === 'time' ? 'compare.intro.time' : 'compare.intro')}</span>
        )}
      </StatsBar>

      <div className="self-start">
      <Segmented<Mode>
        ariaLabel={t('compare.mode')}
        value={mode}
        onChange={(next) => { setMode(next); setResult(null); setError(null) }}
        options={[
          { id: 'stands', label: t('compare.mode.stands') },
          { id: 'time', label: t('compare.mode.time') },
        ]}
      />
      </div>

      {mode === 'stands' ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">{server.baseUrl}</Badge>
          <ArrowsLeftRight size={14} className="text-content-subtle" />
          <Select<string>
            ariaLabel={t('compare.other')}
            label={t('compare.other')}
            className="w-72"
            value={otherId ?? ''}
            onChange={(id) => { setOtherId(id || null); setPassword(''); setResult(null) }}
            options={[
              { id: '', label: t('compare.pick') },
              ...others.map((profile) => ({ id: profile.id, label: profile.name, hint: profile.url })),
            ]}
          />
          {other && !other.rememberPassword && (
            // Ширина задаётся обёрткой: у поля своя `w-full`, и в строке
            // фильтров оно расталкивало кнопку на следующую строку.
            <div className="w-44">
              <TextInput
                type="password"
                value={password}
                placeholder={t('api.password')}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          )}
          <Button
            variant="primary"
            className="min-w-40"
            disabled={!other || needsPassword || running}
            onClick={() => void run()}
          >
            <ButtonGlyph busy={running}><ArrowsLeftRight size={14} weight="bold" /></ButtonGlyph>
            {t('compare.run')}
          </Button>
        </div>
      ) : (
        <>
          {/* Снимок — это чтение, как и сравнение: на стенде ничего не меняется. */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-72">
              <TextInput
                value={label}
                placeholder={t('compare.snapshot.label')}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            <Button disabled={taking} onClick={() => void take()}>
              <ButtonGlyph busy={taking}><Camera size={14} weight="bold" /></ButtonGlyph>
              {t('compare.snapshot.take')}
            </Button>
            <span className="text-[11.5px] text-content-subtle">{t('compare.snapshot.hint')}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Select<string>
              ariaLabel={t('compare.before')}
              label={t('compare.before')}
              className="w-80"
              value={before ?? ''}
              onChange={(id) => { setBefore(id || null); setResult(null) }}
              options={mine.length > 0
                ? mine.map((entry) => ({ id: entry.id, label: snapshotLabel(entry) }))
                : [{ id: '', label: t('compare.snapshot.none') }]}
            />
            {before && (
              <IconButton icon={Trash} label={t('compare.snapshot.delete')} tone="danger" size="md" onClick={() => void remove(before)} />
            )}
            <ArrowRight size={14} className="text-content-subtle" />
            <Select<string>
              ariaLabel={t('compare.after')}
              label={t('compare.after')}
              className="w-80"
              value={after}
              onChange={(id) => { setAfter(id); setResult(null) }}
              options={[
                { id: NOW, label: t('compare.snapshot.now') },
                ...mine.filter((entry) => entry.id !== before).map((entry) => ({ id: entry.id, label: snapshotLabel(entry) })),
              ]}
            />
            <Button
              variant="primary"
              className="min-w-40"
              disabled={!before || running}
              onClick={() => void runTime()}
            >
              <ButtonGlyph busy={running}><ArrowsLeftRight size={14} weight="bold" /></ButtonGlyph>
              {t('compare.run')}
            </Button>
          </div>
        </>
      )}

      <ErrorBar error={error} />

      {result && (
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<Part>
            ariaLabel={t('compare.part')}
            value={part}
            onChange={(next) => { setPart(next); setQuery('') }}
            options={[
              { id: 'properties', label: `${t('compare.properties')} · ${result.properties.length}` },
              { id: 'routes', label: `${t('compare.routes')} · ${result.routes.length}` },
              { id: 'domains', label: `${t('compare.domains')} · ${result.domains.length}` },
            ]}
          />
          <Select<Side | 'all'>
            ariaLabel={t('compare.side')}
            label={t('compare.side')}
            className="w-56"
            value={side}
            onChange={setSide}
            options={[
              { id: 'all', label: t('filter.all') },
              { id: 'onlyLeft', label: sideLabel('onlyLeft') },
              { id: 'onlyRight', label: sideLabel('onlyRight') },
              { id: 'differs', label: sideLabel('differs') },
            ]}
          />
          <SearchInput
            className="min-w-64 flex-1"
            value={query}
            placeholder={t('compare.search')}
            onChange={setQuery}
          />
          {result.securedSkipped > 0 && (
            <span className="text-[11.5px] text-content-subtle" title={t('compare.secured.hint')}>
              {t('compare.secured', { count: result.securedSkipped })}
            </span>
          )}
        </div>
      )}

      <Panel className="flex-1">
        <DataTable>
          <colgroup>
            <col className="w-28" />
            <col className="w-52" />
            <col />
            <col />
            <col />
          </colgroup>
          <THead>
            <Th>{t('compare.side')}</Th>
            <Th>{t('compare.where')}</Th>
            <Th>{t('compare.name')}</Th>
            <Th>{t(mode === 'time' ? 'compare.before' : 'compare.left')}</Th>
            <Th>{t(mode === 'time' ? 'compare.after' : 'compare.right')}</Th>
          </THead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.side}/${row.scope}/${row.name}`} className="border-b border-line/60 hover:bg-surface-2">
                <td className="px-3 py-1.5">
                  <Badge tone={SIDE_TONE[row.side]}>{sideLabel(row.side)}</Badge>
                </td>
                <td className="truncate px-3 py-1.5 text-content-muted" title={row.scope}>{row.scope || '—'}</td>
                <td className="truncate px-3 py-1.5 font-medium" title={row.name}>{row.name}</td>
                <Value text={row.left} />
                <Value text={row.right} />
              </tr>
            ))}
            {rows.length === 0 && (
              <TableMessage colSpan={5} busy={running}>
                {running
                  ? t('compare.running')
                  : result
                    ? t('compare.same')
                    : t(mode === 'time' ? (mine.length > 0 ? 'compare.snapshot.pick' : 'compare.snapshot.empty') : 'compare.pick')}
              </TableMessage>
            )}
          </tbody>
        </DataTable>
      </Panel>
    </ScreenBody>
  )
}

/** Значение одной стороны: прочерк там, где строки на этой стороне нет. */
function Value({ text }: { text: string | null }) {
  return (
    <td className={cx('truncate px-3 py-1.5 font-mono text-[11.5px]', text === null && 'text-content-subtle')}>
      <span title={text ?? undefined}>{text === null ? '—' : text || '""'}</span>
    </td>
  )
}

const SIDE_LABEL: Record<Side, MessageKey> = {
  onlyLeft: 'compare.side.onlyLeft',
  onlyRight: 'compare.side.onlyRight',
  differs: 'compare.side.differs',
}

/** Во времени «только слева» — это то, что было и пропало. */
const TIME_LABEL: Record<Side, MessageKey> = {
  onlyLeft: 'compare.time.removed',
  onlyRight: 'compare.time.added',
  differs: 'compare.time.changed',
}

const SIDE_TONE: Record<Side, 'accent' | 'warn' | 'neutral'> = {
  onlyLeft: 'accent',
  onlyRight: 'neutral',
  differs: 'warn',
}

/** Профиль превращается в подключение только на время сравнения. */
