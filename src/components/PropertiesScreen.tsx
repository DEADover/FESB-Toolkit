import { useCallback, useMemo, useState } from 'react'

import { useI18n } from '../i18n'
import { apiDeleteProperty, apiDomains, apiProperties, apiSaveProperty, errorText } from '../lib/api'
import type { ApiDomain, Connection, PropertyRow, PropertyScope, ServerInfo } from '../types'
import { ErrorBar, NotConnected, Panel, TableMessage, useApiData } from './ApiShell'
import { Badge, Button, Checkbox, Modal, Segmented, Spinner, SuggestInput, TextInput, cx } from './ui'

interface Props {
  connection: Connection | null
  server: ServerInfo | null
  onGoToConnection: () => void
}

type ScopeId = 'application' | 'broker' | 'domain'

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
  const [editing, setEditing] = useState<{ property: PropertyRow; create: boolean } | null>(null)
  const [removing, setRemoving] = useState<PropertyRow | null>(null)
  const [saving, setSaving] = useState(false)

  const loadDomains = useCallback((connection: Connection) => apiDomains(connection), [])
  const domains = useApiData<ApiDomain[]>(connection, loadDomains)

  const scope = useMemo<PropertyScope | null>(() => {
    if (scopeId === 'application') return 'application'
    if (scopeId === 'broker') return 'broker'
    return domainGuid ? { domain: domainGuid } : null
  }, [scopeId, domainGuid])

  const loadProperties = useCallback(
    (connection: Connection) => (scope ? apiProperties(connection, scope) : Promise.resolve([])),
    [scope],
  )
  const { data, loading, error, reload, setError } = useApiData<PropertyRow[]>(connection, loadProperties)

  const visible = useMemo(() => {
    const rows = data ?? []
    const needle = query.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter((row) =>
      row.key.toLowerCase().includes(needle) ||
      (row.value ?? '').toLowerCase().includes(needle) ||
      (row.description ?? '').toLowerCase().includes(needle))
  }, [data, query])

  const save = useCallback(async () => {
    if (!connection || !scope || !editing) return
    setSaving(true)
    setError(null)
    try {
      await apiSaveProperty(connection, scope, editing.property, editing.create)
      setEditing(null)
      await reload()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }, [connection, scope, editing, reload, setError])

  const remove = useCallback(async () => {
    if (!connection || !scope || !removing) return
    setSaving(true)
    setError(null)
    try {
      await apiDeleteProperty(connection, scope, removing.key)
      setRemoving(null)
      await reload()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }, [connection, scope, removing, reload, setError])

  if (!connection || !server) return <NotConnected onGoToConnection={onGoToConnection} />

  const domainNames = (domains.data ?? []).map((domain) => domain.name)
  const selectedDomain = (domains.data ?? []).find((domain) => domain.guid === domainGuid)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-4">
      <div className="flex items-center gap-2">
        <Segmented<ScopeId>
          ariaLabel={t('properties.scope')}
          value={scopeId}
          onChange={setScopeId}
          options={[
            { id: 'application', label: t('properties.scope.application') },
            { id: 'broker', label: t('properties.scope.broker') },
            { id: 'domain', label: t('properties.scope.domain') },
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

        <div className="relative min-w-0 flex-1">
          <TextInput
            value={query}
            placeholder={t('properties.search')}
            className="pl-8"
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle">⌕</span>
        </div>

        <Button
          variant="primary"
          disabled={!scope}
          onClick={() => setEditing({ property: { ...EMPTY }, create: true })}
        >
          {t('properties.add')}
        </Button>
        <Button onClick={() => void reload()} disabled={loading || !scope}>
          {loading ? <Spinner className="size-4" /> : '↻'} {t('action.refresh')}
        </Button>
      </div>

      <ErrorBar error={error ?? domains.error} />

      <Panel className="flex-1">
        <table className="w-full table-fixed border-collapse text-[12.5px]">
          <colgroup>
            <col className="w-80" />
            <col />
            <col className="w-56" />
            <col className="w-32" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-surface-2 text-[11px] tracking-wide text-content-subtle">
            <tr className="border-b border-line">
              <th className="px-3 py-2 text-left font-medium">{t('properties.key')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('properties.value')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('table.description')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('modules.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((property) => (
              <tr key={property.key} className="border-b border-line/60 hover:bg-surface-2">
                <td className="px-3 py-1.5">
                  <div className="truncate font-mono text-[12px]" title={property.key}>{property.key}</div>
                </td>
                <td className="px-3 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cx('min-w-0 flex-1 truncate font-mono text-[12px]', property.secured && 'text-content-subtle')}
                      title={property.secured ? t('properties.securedHint') : property.value ?? ''}
                    >
                      {property.secured ? '••••••••' : property.value || '—'}
                    </span>
                    {property.vault && <Badge tone="accent">{t('properties.vault')}</Badge>}
                  </div>
                </td>
                <td className="truncate px-3 py-1.5 text-content-muted" title={property.description ?? ''}>
                  {property.description || '—'}
                </td>
                <td className="px-3 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" onClick={() => setEditing({ property: { ...property }, create: false })}>
                      {t('properties.edit')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRemoving(property)}>
                      {t('properties.delete')}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <TableMessage colSpan={4}>
                {loading
                  ? t('empty.scanning')
                  : scopeId === 'domain' && !domainGuid
                    ? t('properties.pickDomain')
                    : t('properties.empty')}
              </TableMessage>
            )}
          </tbody>
        </table>
      </Panel>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        closeLabel={t('action.close')}
        title={editing?.create ? t('properties.add') : t('properties.edit')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>{t('action.cancel')}</Button>
            <Button
              variant="primary"
              disabled={saving || !editing?.property.key.trim()}
              onClick={() => void save()}
            >
              {saving ? <Spinner className="size-4" /> : t('properties.save')}
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-3">
            <Field label={t('properties.key')} htmlFor="property-key">
              <TextInput
                id="property-key"
                value={editing.property.key}
                disabled={!editing.create}
                className="font-mono"
                onChange={(event) => setEditing({ ...editing, property: { ...editing.property, key: event.target.value } })}
              />
            </Field>
            <Field label={t('properties.value')} htmlFor="property-value">
              <TextInput
                id="property-value"
                value={editing.property.value ?? ''}
                className="font-mono"
                onChange={(event) => setEditing({ ...editing, property: { ...editing.property, value: event.target.value } })}
              />
            </Field>
            <Field label={t('table.description')} htmlFor="property-description">
              <TextInput
                id="property-description"
                value={editing.property.description ?? ''}
                onChange={(event) => setEditing({ ...editing, property: { ...editing.property, description: event.target.value } })}
              />
            </Field>
            <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-content-muted">
              <Checkbox
                checked={editing.property.secured}
                onChange={(event) => setEditing({ ...editing, property: { ...editing.property, secured: event.target.checked } })}
              />
              {t('properties.secured')}
            </label>
            {editing.property.secured && (
              <p className="rounded-lg border border-caution/35 bg-caution/10 px-3 py-2 text-[11.5px] text-caution">
                {t('properties.securedHint')}
              </p>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        closeLabel={t('action.close')}
        title={t('properties.confirmDelete')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>{t('action.cancel')}</Button>
            <Button variant="primary" disabled={saving} onClick={() => void remove()}>
              {saving ? <Spinner className="size-4" /> : t('properties.delete')}
            </Button>
          </>
        }
      >
        {removing && (
          <div className="space-y-3 text-[13px] leading-relaxed">
            <code className="block break-all rounded bg-accent/12 px-2 py-1 font-mono text-accent-content">{removing.key}</code>
            <p className="text-content-muted">{t('properties.confirmDeleteText')}</p>
          </div>
        )}
      </Modal>
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
