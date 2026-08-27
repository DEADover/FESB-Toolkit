import { useCallback, useMemo, useState } from 'react'

import { Certificate, DownloadSimple } from '@phosphor-icons/react'

import { useI18n, type MessageKey, type Translate } from '../i18n'
import { apiCertificates, errorText, saveReport, saveXlsxAs } from '../lib/api'
import { localStamp } from '../lib/paths'
import type { ApiCertificate, CertificateReport, Connection, ServerInfo } from '../types'
import {
  ErrorBar, NotConnected, Panel, RefreshButton, ScreenBody, StatsBar, TableMessage, useApiData, useDebounced,
} from './ApiShell'
import {
  Badge, Button, ButtonGlyph, CodePill, cx, DataTable, EmptyState, Modal, MultiSelect, Readout,
  rowClick, SearchInput, Th, THead, Toggle,
} from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  onGoToConnection: () => void
}

/**
 * За сколько дней до конца сертификат считается проблемой.
 *
 * Девяносто — не круглое число, а срок, за который в любой организации
 * успевают выпустить и поставить новый: короче — уже гонка.
 */
const SOON_DAYS = 90

/** Совсем близко: тут уже не «пора заняться», а «горит». */
const URGENT_DAYS = 30

/** Сколько дней осталось до конца действия; отрицательное — уже просрочен. */
function daysLeft(notAfter: string): number | null {
  const end = new Date(notAfter).getTime()
  if (Number.isNaN(end)) return null
  return Math.floor((end - Date.now()) / 86_400_000)
}

/** `2035-03-23T09:02:55` → `23.03.2035`: в таблице нужна дата, не отметка времени. */
function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value
}

/** Ключ одной строкой: `RSA 2048`. */
function keyText(row: ApiCertificate): string {
  return [row.keyAlgorithm, row.keyBits ? String(row.keyBits) : ''].filter(Boolean).join(' ')
}

/**
 * Колонки: один список на таблицу и на файл.
 *
 * Порядок повторяет то, как сертификат читают глазами: где лежит, как
 * называется, кому и кем выдан, до каких пор — и только потом техника.
 */
const COLUMNS: Array<{
  key: MessageKey
  width: string
  text: (row: ApiCertificate, t: Translate) => string
}> = [
  { key: 'certificates.store', width: 'w-32', text: (row) => row.store },
  { key: 'certificates.alias', width: 'w-32', text: (row) => row.alias },
  { key: 'certificates.subject', width: 'w-52', text: (row) => row.subjectName },
  { key: 'certificates.issuer', width: 'w-52', text: (row) => row.issuerName },
  { key: 'certificates.validFrom', width: 'w-24', text: (row) => formatDate(row.notBefore) },
  { key: 'certificates.validTo', width: 'w-24', text: (row) => formatDate(row.notAfter) },
  {
    key: 'certificates.left',
    width: 'w-24',
    text: (row, t) => {
      const left = daysLeft(row.notAfter)
      if (left === null) return ''
      return left < 0 ? t('certificates.expiredLabel') : t('certificates.days', { count: left })
    },
  },
  { key: 'certificates.key', width: 'w-24', text: keyText },
  { key: 'certificates.algorithm', width: 'w-36', text: (row) => row.algorithm },
  { key: 'certificates.usage', width: 'w-56', text: (row) => row.usage.join(', ') },
  { key: 'certificates.serial', width: 'w-40', text: (row) => row.serial },
]

/**
 * Сертификаты хранилищ шины.
 *
 * Отчёт по точкам входа и выхода отвечает, что соединение защищено;
 * этот раздел — чем именно и до какого числа. Поэтому список приходит уже
 * отсортированным по дате окончания, а срок показан не датой, а остатком
 * дней: «до 23.03.2035» ни о чём не говорит, «осталось 12 дней» говорит всё.
 */
export function CertificatesScreen({ connection, server, onGoToConnection }: Props) {
  const { t } = useI18n()
  const load = useCallback((open: Connection) => apiCertificates(open), [])
  const { data, loading, error, reload, setError } = useApiData<CertificateReport>(connection, load)

  const [search, setSearch] = useState('')
  const [stores, setStores] = useState<Set<string>>(new Set())
  const [onlyProblem, setOnlyProblem] = useState(false)
  const [open, setOpen] = useState<ApiCertificate | null>(null)
  const [saving, setSaving] = useState(false)
  const query = useDebounced(search, 250)

  const all = useMemo(() => data?.certificates ?? [], [data])

  const storeOptions = useMemo(
    () => (data?.stores ?? []).map((store) => ({
      id: store.name,
      label: store.name,
      hint: `${t(kindLabel(store.kind))} · ${store.count > 0 ? store.count : t('certificates.emptyStore')}`,
    })),
    [data, t],
  )

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return all.filter((row) => {
      if (stores.size > 0 && !stores.has(row.store)) return false
      if (onlyProblem) {
        const left = daysLeft(row.notAfter)
        if (left === null || left > SOON_DAYS) return false
      }
      if (!needle) return true
      return (
        row.alias.toLowerCase().includes(needle) ||
        row.subject.toLowerCase().includes(needle) ||
        row.issuer.toLowerCase().includes(needle) ||
        row.store.toLowerCase().includes(needle)
      )
    })
  }, [all, query, stores, onlyProblem])

  const totals = useMemo(() => {
    const left = all.map((row) => daysLeft(row.notAfter))
    return {
      total: all.length,
      stores: data?.stores.length ?? 0,
      expiring: left.filter((days) => days !== null && days >= 0 && days <= SOON_DAYS).length,
      expired: left.filter((days) => days !== null && days < 0).length,
    }
  }, [all, data])

  /** В файл уходит то, что видно на экране: фильтры — часть отчёта. */
  const exportXlsx = useCallback(async () => {
    const headers = COLUMNS.map((column) => t(column.key))
    const body = visible.map((row) => COLUMNS.map((column) => column.text(row, t)))

    const output = await saveXlsxAs(t('certificates.save'), `fesb-certificates-${localStamp()}.xlsx`)
    if (!output) return
    setSaving(true)
    setError(null)
    try {
      await saveReport(output, t('nav.api.certificates'), headers, body)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }, [visible, t, setError])

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  if (data !== null && all.length === 0) {
    return (
      <ScreenBody>
        <ErrorBar error={error} />
        <EmptyState icon={Certificate} title={t('certificates.empty')} text={t('certificates.empty.text')}>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {data.stores.map((store) => (
              <Badge key={`${store.kind}-${store.name}`}>
                {store.name} · {t(store.kind === 'key' ? 'certificates.kind.key' : 'certificates.kind.trusted')}
              </Badge>
            ))}
          </div>
        </EmptyState>
      </ScreenBody>
    )
  }

  return (
    <ScreenBody>
      <StatsBar>
        <Readout label={t('certificates.total')} value={totals.total.toLocaleString()} />
        <Readout label={t('certificates.stores')} value={totals.stores.toLocaleString()} />
        <Readout
          label={t('certificates.expiring')}
          value={totals.expiring.toLocaleString()}
          tone={totals.expiring > 0 ? 'warn' : undefined}
          hint={t('certificates.expiring.hint')}
        />
        <Readout
          label={t('certificates.expired')}
          value={totals.expired.toLocaleString()}
          tone={totals.expired > 0 ? 'danger' : undefined}
        />
        <div className="ml-auto flex items-center gap-2">
          <RefreshButton className="min-w-32" busy={loading} onClick={() => void reload()} />
          <Button
            variant="primary"
            className="min-w-52"
            disabled={saving || visible.length === 0}
            onClick={() => void exportXlsx()}
          >
            <ButtonGlyph busy={saving}><DownloadSimple size={14} weight="bold" /></ButtonGlyph>
            {t('certificates.export', { count: visible.length })}
          </Button>
        </div>
      </StatsBar>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          className="min-w-64 flex-1"
          value={search}
          placeholder={t('certificates.search')}
          onChange={setSearch}
          clearLabel={t('action.clearSearch')}
        />
        <MultiSelect
          label={t('certificates.store')}
          emptyLabel={t('filter.all')}
          className="w-56"
          options={storeOptions}
          selected={stores}
          onChange={setStores}
        />
        <Toggle
          checked={onlyProblem}
          onChange={setOnlyProblem}
          label={t('certificates.onlyProblem')}
          title={t('certificates.onlyProblem.hint')}
        />
      </div>

      <ErrorBar error={error} />

      <Panel className="flex-1">
        <DataTable wide>
          <colgroup>
            {COLUMNS.map((column) => <col key={column.key} className={column.width} />)}
          </colgroup>
          <THead>
            {COLUMNS.map((column) => (
              <Th key={column.key} className="whitespace-nowrap">{t(column.key)}</Th>
            ))}
          </THead>
          <tbody>
            {visible.map((row) => (
              <tr
                key={`${row.storeKind}:${row.store}:${row.alias}:${row.serial}`}
                onClick={rowClick(() => setOpen(row))}
                title={t('certificates.openHint')}
                className="cursor-pointer border-b border-line/60 align-top hover:bg-surface-2"
              >
                <td className="truncate px-3 py-1.5" title={t(kindHint(row.storeKind))}>
                  <span className="font-mono text-[11px]">{row.store}</span>
                </td>
                <td className="truncate px-3 py-1.5 font-medium">{row.alias || '—'}</td>
                <td className="truncate px-3 py-1.5" title={row.subject}>{row.subjectName || '—'}</td>
                <td className="truncate px-3 py-1.5" title={row.issuer}>
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 truncate">{row.issuerName || '—'}</span>
                    {row.selfSigned && <Badge>{t('certificates.selfSigned')}</Badge>}
                    {row.authority && (
                      <Badge tone="accent" title={t('certificates.authority.hint')}>{t('certificates.authority')}</Badge>
                    )}
                  </span>
                </td>
                <td className="px-3 py-1.5 tabular-nums text-content-muted">{formatDate(row.notBefore)}</td>
                <td className="px-3 py-1.5 tabular-nums">{formatDate(row.notAfter)}</td>
                <td className="px-3 py-1.5"><Expiry days={daysLeft(row.notAfter)} notBefore={row.notBefore} /></td>
                <td className="truncate px-3 py-1.5">
                  {keyText(row) ? <CodePill>{keyText(row)}</CodePill> : '—'}
                </td>
                <td className="truncate px-3 py-1.5 font-mono text-[11px] text-content-muted">
                  {row.algorithm || '—'}
                </td>
                <td className="truncate px-3 py-1.5 text-[11.5px] text-content-muted" title={row.usage.join(', ')}>
                  {row.usage.join(', ') || '—'}
                </td>
                <td className="truncate px-3 py-1.5 font-mono text-[10.5px] text-content-subtle">
                  {row.serial || '—'}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <TableMessage colSpan={COLUMNS.length}>
                {loading ? t('empty.scanning') : t('certificates.nothing')}
              </TableMessage>
            )}
          </tbody>
        </DataTable>
      </Panel>

      <CertificateCard certificate={open} onClose={() => setOpen(null)} />
    </ScreenBody>
  )
}

/**
 * Полное описание сертификата отдельным окном.
 *
 * Разворачивать его строкой в таблице было неудобно вдвойне: полные имена
 * всё равно не помещались в ширину колонки, а соседние строки уезжали вниз,
 * и сравнить два сертификата глазами становилось нельзя. В окне помещается
 * всё — и то, что уже показано в таблице, тоже: карточку открывают, чтобы
 * увидеть сертификат целиком, а не половину.
 */
function CertificateCard({ certificate, onClose }: {
  certificate: ApiCertificate | null
  onClose: () => void
}) {
  const { t } = useI18n()
  if (!certificate) return null

  const left = daysLeft(certificate.notAfter)
  return (
    <Modal
      open
      width="roomy"
      onClose={onClose}
      closeLabel={t('action.close')}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{certificate.alias || certificate.subjectName || '—'}</span>
          <Expiry days={left} notBefore={certificate.notBefore} />
        </span>
      }
      footer={<Button onClick={onClose}>{t('action.close')}</Button>}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{t(kindLabel(certificate.storeKind))}</Badge>
          {certificate.selfSigned && <Badge>{t('certificates.selfSigned')}</Badge>}
          {certificate.authority && (
            <Badge tone="accent" title={t('certificates.authority.hint')}>{t('certificates.authority')}</Badge>
          )}
        </div>

        <dl className="grid grid-cols-[11rem_1fr] gap-x-4 gap-y-1.5 text-[11.5px]">
          <Line label={t('certificates.store')} value={certificate.store} mono />
          <Line label={t('certificates.alias')} value={certificate.alias} mono />
          <Line label={t('certificates.subject')} value={certificate.subject} mono />
          <Line label={t('certificates.issuer')} value={certificate.issuer} mono />
          <Line label={t('certificates.validFrom')} value={certificate.notBefore.replace('T', ' ')} />
          <Line label={t('certificates.validTo')} value={certificate.notAfter.replace('T', ' ')} />
          <Line
            label={t('certificates.left')}
            value={left === null
              ? ''
              : left < 0 ? t('certificates.expiredLabel') : t('certificates.days', { count: left })}
          />
          <Line label={t('certificates.key')} value={keyText(certificate)} />
          <Line label={t('certificates.algorithm')} value={certificate.algorithm} mono />
          <Line label={t('certificates.usage')} value={certificate.usage.join(', ')} />
          <Line label={t('certificates.serial')} value={certificate.serial} mono />
          {certificate.chainPath.length > 0 && (
            <Line label={t('certificates.chain')} value={certificate.chainPath.join('  →  ')} />
          )}
        </dl>
      </div>
    </Modal>
  )
}

/**
 * Остаток срока — главное число раздела, поэтому оно цветное.
 *
 * Просрочен — красное, меньше месяца — тоже: за месяц выпустить и поставить
 * новый успевают уже не везде. До трёх месяцев — жёлтое, дальше — обычное.
 */
function Expiry({ days, notBefore }: { days: number | null; notBefore: string }) {
  const { t } = useI18n()
  if (days === null) return <span className="text-content-subtle">—</span>
  if (days < 0) return <Badge tone="danger">{t('certificates.expiredLabel')}</Badge>
  const start = new Date(notBefore).getTime()
  if (!Number.isNaN(start) && start > Date.now()) return <Badge tone="accent">{t('certificates.notYet')}</Badge>
  const tone = days <= URGENT_DAYS ? 'danger' : days <= SOON_DAYS ? 'warn' : 'neutral'
  return <Badge tone={tone}>{t('certificates.days', { count: days })}</Badge>
}

function Line({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-content-subtle">{label}</dt>
      <dd className={cx('break-all text-content-muted', mono && 'font-mono text-[11px]')}>{value || '—'}</dd>
    </>
  )
}

/** Подпись вида хранилища и его пояснение. */
function kindLabel(kind: 'key' | 'trusted'): MessageKey {
  return kind === 'key' ? 'certificates.kind.key' : 'certificates.kind.trusted'
}

function kindHint(kind: 'key' | 'trusted'): MessageKey {
  return kind === 'key' ? 'certificates.kind.key.hint' : 'certificates.kind.trusted.hint'
}
