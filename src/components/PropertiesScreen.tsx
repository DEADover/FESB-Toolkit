import { useCallback, useEffect, useMemo, useRef, useState } from 'react'


import { useI18n } from '../i18n'
import { apiDomains, apiProperties, apiPropertiesSweep, apiSaveProperty, errorText } from '../lib/api'
import { humanizeKey } from '../lib/propertyName'
import type { ApiDomain, Connection, PropertyRow, PropertyScope, ServerInfo, SweepRow } from '../types'
import {
  ErrorBar, NotConnected, Panel, RefreshButton, ScreenBody, TableMessage, useApiData,
} from './ApiShell'
import { PropertiesBulk, plain, scopeOf } from './PropertiesBulk'
import { Badge, Button, Checkbox, cx, DataTable, Modal, Notice, SearchInput, Segmented, Spinner, SuggestInput, TextInput, Th, THead } from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  onGoToConnection: () => void
}

type ScopeId = 'application' | 'broker' | 'domain' | 'all'

const EMPTY: PropertyRow = { key: '', value: '', secured: false, vault: false, empty: false, description: '' }

/**
 * Константы приложения, брокера и доменов.
 *
 * Именно их подставляют в СОПС как `{{const.url.…}}`, и именно из-за пропавшей
 * константы маршрут падает на старте — поэтому смотреть и править их полезно
 * прямо здесь, не открывая веб-интерфейс.
 */
export function PropertiesScreen({ connection, server, onGoToConnection }: Props) {
  const { t } = useI18n()

  const [scopeId, setScopeId] = useState<ScopeId>('application')
  const [domainGuid, setDomainGuid] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState<PropertyRow | null>(null)
  const [saving, setSaving] = useState(false)
  /** Ключ константы, которая сейчас сохраняется: строка ждёт ответа. */
  const [pending, setPending] = useState<string | null>(null)
  /** Что отмечено на весь стенд: ключ строки — уровень и имя константы. */
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [replacing, setReplacing] = useState(false)

  const loadDomains = useCallback((connection: Connection) => apiDomains(connection), [])
  const domains = useApiData<ApiDomain[]>(connection, loadDomains)

  const scope = useMemo<PropertyScope | null>(() => {
    if (scopeId === 'application') return 'application'
    if (scopeId === 'broker') return 'broker'
    return domainGuid ? { domain: domainGuid } : null
  }, [scopeId, domainGuid])

  /**
   * Строки всегда приходят в одном виде — со своим уровнем внутри.
   *
   * Так таблица, правка на месте и массовая замена работают одинаково
   * и на одном уровне, и на всём стенде: строка сама знает, куда её писать.
   */
  const loadRows = useCallback(async (connection: Connection): Promise<SweepRow[]> => {
    if (scopeId === 'all') return apiPropertiesSweep(connection)
    if (!scope) return []
    const rows = await apiProperties(connection, scope)
    const level = scopeId === 'domain' ? domainGuid ?? '' : scopeId
    return rows.map((row) => ({ ...row, scope: level, domain: null }))
  }, [scopeId, scope, domainGuid])
  const { data, loading, error, reload, setError } = useApiData<SweepRow[]>(connection, loadRows)

  const visible = useMemo(() => {
    const rows = data ?? []
    const needle = query.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter((row) =>
      row.key.toLowerCase().includes(needle) ||
      (row.value ?? '').toLowerCase().includes(needle) ||
      (row.domain ?? '').toLowerCase().includes(needle) ||
      (row.description ?? '').toLowerCase().includes(needle))
  }, [data, query])

  const chosen = useMemo(() => visible.filter((row) => selected.has(rowKey(row))), [visible, selected])

  // Смена уровня меняет и состав строк: отметки на прежнем списке
  // означали бы правку не того, что видно.
  useEffect(() => { setSelected(new Set()) }, [scopeId, domainGuid])

  const create = useCallback(async () => {
    if (!connection || !scope || !adding) return
    setSaving(true)
    setError(null)
    try {
      await apiSaveProperty(connection, scope, adding, true)
      setAdding(null)
      await reload()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }, [connection, scope, adding, reload, setError])

  /**
   * Сохранение прямо из таблицы.
   *
   * Диалог ради одного поля — лишний шаг: константы правят по одному значению
   * и сразу видят соседние. Строка сохраняется по Enter или уходу фокуса.
   */
  const saveField = useCallback(async (row: SweepRow, patch: Partial<PropertyRow>) => {
    if (!connection) return
    setPending(row.key)
    setError(null)
    try {
      await apiSaveProperty(connection, scopeOf(row), { ...plain(row), ...patch }, false)
      await reload()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setPending(null)
    }
  }, [connection, reload, setError])

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  const domainNames = (domains.data ?? []).map((domain) => domain.name)
  const selectedDomain = (domains.data ?? []).find((domain) => domain.guid === domainGuid)
  const sweeping = scopeId === 'all'
  const allVisibleSelected = visible.length > 0 && visible.every((row) => selected.has(rowKey(row)))

  return (
    <ScreenBody>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<ScopeId>
          ariaLabel={t('properties.scope')}
          value={scopeId}
          onChange={setScopeId}
          options={[
            { id: 'application', label: t('properties.scope.application') },
            { id: 'broker', label: t('properties.scope.broker') },
            { id: 'domain', label: t('properties.scope.domain') },
            { id: 'all', label: t('properties.scope.all') },
          ]}
        />

        {scopeId === 'domain' && (
          <div className="w-64">
            <SuggestInput
              id="properties-domain"
              value={selectedDomain?.name ?? ''}
              options={domainNames}
              placeholder={t('properties.pickDomain')}
              emptyLabel={t('apply.noSuggestions')}
              onChange={(name) => {
                const match = (domains.data ?? []).find((domain) => domain.name === name)
                setDomainGuid(match?.guid ?? null)
              }}
            />
          </div>
        )}

        <SearchInput
          className="min-w-64 flex-1"
          value={query}
          placeholder={t('properties.search')}
          onChange={setQuery}
        />

        {/* Константы приложения — собственные настройки шины: их состав
            задан ею, и своя запись здесь ничего не включит. */}
        <Button
          variant="primary"
          disabled={!scope || scopeId === 'application'}
          title={scopeId === 'application' ? t('properties.add.fixed') : undefined}
          onClick={() => setAdding({ ...EMPTY })}
        >
          {t('properties.add')}
        </Button>
        <RefreshButton
          busy={loading}
          disabled={loading || (!scope && scopeId !== 'all')}
          onClick={() => void reload()}
        />
      </div>

      <ErrorBar error={error ?? domains.error} />

      <Panel className="flex-1">
        <DataTable>
          <colgroup>
            {sweeping && <col className="w-9" />}
            {sweeping && <col className="w-44" />}
            {/* Имя и значение делят остаток поровну: оба длинные, и жёсткая
                ширина у имени на узком окне съедала значение целиком. */}
            <col />
            <col />
            <col className="w-56" />
          </colgroup>
          <THead>
              {sweeping && (
                <Th className="w-9">
                  <Checkbox
                    checked={allVisibleSelected}
                    title={t('properties.selectAll')}
                    onChange={(event) => setSelected(event.target.checked
                      ? new Set(visible.map(rowKey))
                      : new Set())}
                  />
                </Th>
              )}
              {sweeping && <Th>{t('properties.where')}</Th>}
              <Th>{t('properties.key')}</Th>
              <Th>{t('properties.value')}</Th>
              <Th>{t('properties.comment')}</Th>
            </THead>
          <tbody>
            {visible.map((property) => (
              <tr
                key={rowKey(property)}
                className={cx(
                  'border-b border-line/60 align-top',
                  selected.has(rowKey(property)) ? 'bg-accent/8' : 'hover:bg-surface-2',
                )}
              >
                {sweeping && (
                  <td className="px-3 py-2">
                    <Checkbox
                      checked={selected.has(rowKey(property))}
                      onChange={(event) => setSelected((prev) => {
                        const next = new Set(prev)
                        if (event.target.checked) next.add(rowKey(property))
                        else next.delete(rowKey(property))
                        return next
                      })}
                    />
                  </td>
                )}
                {sweeping && (
                  <td className="px-3 py-1.5">
                    <div className="truncate text-[12px]" title={property.domain ?? property.scope}>
                      {property.domain ?? t(`properties.scope.${property.scope}` as 'properties.scope.broker')}
                    </div>
                  </td>
                )}
                <td className="px-3 py-1.5">
                  <div className="truncate text-[12.5px] font-medium" title={property.key}>
                    {humanizeKey(property.key, t)}
                  </div>
                  <div className="truncate font-mono text-[10.5px] text-content-subtle" title={property.key}>
                    {property.key}
                  </div>
                </td>
                <td className="px-3 py-1">
                  <div className="flex items-center gap-1.5">
                    <InlineEdit
                      value={property.secured ? '' : property.value ?? ''}
                      mono
                      placeholder={property.secured ? '••••••••' : '—'}
                      title={property.secured ? t('properties.securedHint') : property.value ?? ''}
                      busy={pending === property.key}
                      onSave={(value) => void saveField(property, { value })}
                    />
                    {property.vault && <Badge tone="accent">{t('properties.vault')}</Badge>}
                  </div>
                </td>
                <td className="px-3 py-1">
                  <InlineEdit
                    value={property.description ?? ''}
                    placeholder={t('properties.commentPlaceholder')}
                    busy={pending === property.key}
                    onSave={(description) => void saveField(property, { description })}
                  />
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <TableMessage colSpan={sweeping ? 5 : 3} busy={loading}>
                {loading ? t('empty.scanning')
                  : scopeId === 'domain' && !domainGuid
                    ? t('properties.pickDomain')
                    : scopeId === 'all'
                      ? t('properties.sweep.empty')
                      : t('properties.empty')}
              </TableMessage>
            )}
          </tbody>
        </DataTable>
      </Panel>

      {sweeping && (
        <div className="flex flex-wrap items-center gap-2">
          {chosen.length > 0 ? (
            <>
              <Badge tone="accent">{t('properties.selected', { count: chosen.length })}</Badge>
              <Button size="sm" variant="primary" onClick={() => setReplacing(true)}>
                {t('properties.replace')}
              </Button>
            </>
          ) : (
            <span className="text-[11.5px] text-content-subtle">{t('properties.scope.allHint')}</span>
          )}
        </div>
      )}

      {connection && (
        <PropertiesBulk
          open={replacing}
          connection={connection}
          rows={chosen}
          initialFrom={query.trim()}
          onClose={() => setReplacing(false)}
          onDone={() => { setSelected(new Set()); void reload() }}
        />
      )}

      <Modal
        open={adding !== null}
        onClose={() => setAdding(null)}
        closeLabel={t('action.close')}
        title={t('properties.add')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(null)}>{t('action.cancel')}</Button>
            <Button variant="primary" className="min-w-28" disabled={saving || !adding?.key.trim()} onClick={() => void create()}>
              {saving ? <Spinner className="size-4" /> : t('properties.save')}
            </Button>
          </>
        }
      >
        {adding && (
          <div className="space-y-3">
            <Field label={t('properties.key')} htmlFor="property-key">
              <TextInput
                id="property-key"
                value={adding.key}
                className="font-mono"
                onChange={(event) => setAdding({ ...adding, key: event.target.value })}
              />
            </Field>
            <Field label={t('properties.value')} htmlFor="property-value">
              <TextInput
                id="property-value"
                value={adding.value ?? ''}
                className="font-mono"
                onChange={(event) => setAdding({ ...adding, value: event.target.value })}
              />
            </Field>
            <Field label={t('properties.comment')} htmlFor="property-description">
              <TextInput
                id="property-description"
                value={adding.description ?? ''}
                onChange={(event) => setAdding({ ...adding, description: event.target.value })}
              />
            </Field>
            <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-content-muted">
              <Checkbox
                checked={adding.secured}
                onChange={(event) => setAdding({ ...adding, secured: event.target.checked })}
              />
              {t('properties.secured')}
            </label>
            {adding.secured && (
              <Notice tone="warn" small>
                {t('properties.securedHint')}
              </Notice>
            )}
          </div>
        )}
      </Modal>

    </ScreenBody>
  )
}

/**
 * Поле, которое правится на месте: выглядит текстом, пока в него не встали.
 *
 * Enter сохраняет, Esc возвращает прежнее значение, уход фокуса сохраняет
 * молча — так правка сотни констант не превращается в сотню диалогов.
 */
/**
 * На сколько поле правки сдвигается влево.
 *
 * У него своя рамка и свой отступ, и текст внутри вставал на семь пикселей
 * правее заголовка колонки — значение переставало стоять под подписью.
 * Сдвигаем поле ровно на эту величину: рамка (1) плюс отступ (6).
 */
const INLINE_EDIT_INSET = '-ml-[7px]'

function InlineEdit({ value, placeholder, title, mono, busy, onSave }: {
  value: string
  placeholder?: string
  title?: string
  mono?: boolean
  busy?: boolean
  onSave: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  // Escape снимает фокус, а снятие фокуса сохраняет. Состояние к этому
  // моменту ещё старое, и правка уезжала на сервер вместо отмены.
  // Флаг живёт вне состояния именно потому, что нужен в том же кадре.
  const cancelled = useRef(false)

  // Пока строку не правят, она следует за данными с сервера.
  useEffect(() => { if (!editing) setDraft(value) }, [value, editing])

  const commit = () => {
    setEditing(false)
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    if (draft !== value) onSave(draft)
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <input
        value={draft}
        placeholder={placeholder}
        title={title}
        spellCheck={false}
        onFocus={() => setEditing(true)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            cancelled.current = true
            setDraft(value)
            setEditing(false)
            event.currentTarget.blur()
          }
        }}
        className={cx(
          'min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-1 text-[12px] outline-none transition',
          'hover:border-line-strong focus:border-accent focus:bg-surface',
          INLINE_EDIT_INSET,
          mono && 'font-mono',
        )}
      />
      {busy && <Spinner className="size-3.5 shrink-0" />}
    </div>
  )
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-[11px] tracking-wide text-content-subtle" htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  )
}

/** Уровень плюс имя: константа с тем же именем живёт в каждом домене своя. */
function rowKey(row: SweepRow): string {
  return `${row.scope}/${row.key}`
}
