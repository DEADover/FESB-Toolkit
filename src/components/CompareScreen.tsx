import { useCallback, useMemo, useState } from 'react'

import { ArrowsLeftRight } from '@phosphor-icons/react'

import { useI18n, type MessageKey } from '../i18n'
import { apiCompareStands, errorText } from '../lib/api'
import { toConnection, type ConnectionProfile, type ConnectionStore } from '../lib/connection'
import type { Comparison, Connection, ServerInfo, Side } from '../types'
import { ErrorBar, NotConnected, Panel, ScreenBody, StatsBar, TableMessage } from './ApiShell'
import {
  Badge, Button, ButtonGlyph, cx, DataTable, Readout, SearchInput, Segmented, Select, Th, THead, TextInput,
} from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  store: ConnectionStore
  activeProfileId: string | null
  onGoToConnection: () => void
}

type Part = 'domains' | 'routes' | 'properties'

/**
 * Чем один стенд отличается от другого.
 *
 * Перед каждым релизом кто-нибудь спрашивает, что на тесте не так, как
 * на бою, и до сих пор на это отвечали двумя окнами браузера и памятью.
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
      setResult(await apiCompareStands(connection, connectionOf(other, password)))
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
          <span className="text-[12px] text-content-muted">{t('compare.intro')}</span>
        )}
      </StatsBar>

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
              { id: 'onlyLeft', label: t('compare.side.onlyLeft') },
              { id: 'onlyRight', label: t('compare.side.onlyRight') },
              { id: 'differs', label: t('compare.side.differs') },
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
            <Th>{t('compare.left')}</Th>
            <Th>{t('compare.right')}</Th>
          </THead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.side}/${row.scope}/${row.name}`} className="border-b border-line/60 hover:bg-surface-2">
                <td className="px-3 py-1.5">
                  <Badge tone={SIDE_TONE[row.side]}>{t(SIDE_LABEL[row.side])}</Badge>
                </td>
                <td className="truncate px-3 py-1.5 text-content-muted" title={row.scope}>{row.scope || '—'}</td>
                <td className="truncate px-3 py-1.5 font-medium" title={row.name}>{row.name}</td>
                <Value text={row.left} />
                <Value text={row.right} />
              </tr>
            ))}
            {rows.length === 0 && (
              <TableMessage colSpan={5} busy={running}>
                {running ? t('compare.running') : result ? t('compare.same') : t('compare.pick')}
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

const SIDE_TONE: Record<Side, 'accent' | 'warn' | 'neutral'> = {
  onlyLeft: 'accent',
  onlyRight: 'neutral',
  differs: 'warn',
}

/** Профиль превращается в подключение только на время сравнения. */
function connectionOf(profile: ConnectionProfile, password: string): Connection {
  return {
    ...toConnection(profile),
    // Пароль, набранный для сравнения, живёт только здесь: сохранять его
    // ради одной операции незачем.
    password: profile.rememberPassword ? profile.password : password,
  }
}
