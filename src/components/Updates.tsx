import { useCallback, useEffect, useRef, useState } from 'react'

import { ArrowCircleUp } from '@phosphor-icons/react'
import { relaunch } from '@tauri-apps/plugin-process'
import { check, type Update } from '@tauri-apps/plugin-updater'

import { useI18n } from '../i18n'
import { errorText } from '../lib/api'
import { useToast } from './Toaster'
import { Button, ButtonGlyph, cx, Modal, Notice } from './ui'

/** Через сколько после запуска спрашивать о новой версии: сначала — дело, потом — обновления. */
const FIRST_CHECK_MS = 10_000

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest' }
  | { kind: 'available'; update: Update }
  | { kind: 'failed'; error: string }

/**
 * Проверка обновлений.
 *
 * Новые версии лежат в релизах на GitHub вместе с `latest.json`, подписанным
 * ключом проекта: приложение ставит только то, что этим ключом подписано.
 * Проверка — один раз вскоре после запуска и по кнопке у номера версии.
 * Молча ничего не ставится: о новой версии говорит всплывашка, а ставит
 * человек, когда ему удобно.
 */
export function useUpdates() {
  const { t } = useI18n()
  const toast = useToast()
  const [state, setState] = useState<UpdateState>({ kind: 'idle' })
  const [dialog, setDialog] = useState(false)
  const latest = useRef({ t, toast })
  latest.current = { t, toast }

  const run = useCallback(async (manual: boolean) => {
    setState({ kind: 'checking' })
    try {
      const update = await check()
      // Ответ без номера версии — не обновление, а сбой: предлагать нечего.
      if (update?.version) {
        setState({ kind: 'available', update })
        if (!manual) {
          const { t, toast } = latest.current
          toast({
            tone: 'ok',
            title: t('update.available', { version: update.version }),
            action: { label: t('update.show'), onClick: () => setDialog(true) },
          })
        } else {
          setDialog(true)
        }
      } else {
        setState({ kind: 'latest' })
        if (manual) latest.current.toast({ tone: 'ok', title: latest.current.t('update.latest') })
      }
    } catch (err) {
      // Без сети или вне приложения (в предпросмотре) проверка просто не
      // удаётся — при автоматической проверке об этом не шумим.
      setState({ kind: 'failed', error: errorText(err) })
      if (manual) latest.current.toast({ tone: 'warn', title: latest.current.t('update.failed'), text: errorText(err) })
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => void run(false), FIRST_CHECK_MS)
    return () => clearTimeout(timer)
  }, [run])

  return { state, check: () => void run(true), dialog, openDialog: () => setDialog(true), closeDialog: () => setDialog(false) }
}

/** Окно новой версии: что нового и кнопка «Обновить и перезапустить». */
export function UpdateDialog({ update, open, onClose }: { update: Update; open: boolean; onClose: () => void }) {
  const { t } = useI18n()
  const [progress, setProgress] = useState<{ done: number; total: number | null } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const install = useCallback(async () => {
    setError(null)
    setProgress({ done: 0, total: null })
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') setProgress({ done: 0, total: event.data.contentLength ?? null })
        if (event.event === 'Progress') {
          setProgress((prev) => ({ done: (prev?.done ?? 0) + event.data.chunkLength, total: prev?.total ?? null }))
        }
      })
      // На Windows установщик сам закрывает приложение; на macOS — перезапуск.
      await relaunch()
    } catch (err) {
      setProgress(null)
      setError(errorText(err))
    }
  }, [update])

  const busy = progress !== null
  const share = progress?.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      closeLabel={t('action.close')}
      title={t('update.title', { version: update.version })}
      width="roomy"
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{t('update.later')}</Button>
          <Button variant="primary" className="min-w-52" disabled={busy} onClick={() => void install()}>
            <ButtonGlyph busy={busy}><ArrowCircleUp size={15} weight="bold" /></ButtonGlyph>
            {busy ? (share !== null ? t('update.downloading', { share }) : t('update.installing')) : t('update.install')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3 text-[13px] leading-relaxed">
        <p className="text-content-muted">{t('update.intro', { current: update.currentVersion, version: update.version })}</p>
        {update.body && (
          <div className="max-h-72 overflow-auto rounded-lg border border-line bg-surface-2/60 p-3 text-[12px] text-content-muted">
            <ReleaseNotes text={update.body} />
          </div>
        )}
        {share !== null && (
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full bg-accent transition-[width]" style={{ width: `${share}%` }} />
          </div>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Modal>
  )
}

/** Убирает разметку внутри строки: `**жирный**`, `` `код` ``, ссылки `[текст](адрес)`. */
function plain(line: string): string {
  return line
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
}

/**
 * Описание релиза — Markdown из GitHub. Целый разборщик ради заголовков
 * и списков не нужен: описания пишутся по одной схеме — разделы
 * `###` и пункты `-`.
 */
export function ReleaseNotes({ text }: { text: string }) {
  const blocks: Array<{ kind: 'title' | 'item' | 'text'; text: string }> = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const title = /^#{1,6}\s+(.*)$/.exec(line)
    const item = /^[-*]\s+(.*)$/.exec(line)
    if (title) blocks.push({ kind: 'title', text: plain(title[1]) })
    else if (item) blocks.push({ kind: 'item', text: plain(item[1]) })
    else blocks.push({ kind: 'text', text: plain(line) })
  }
  return (
    <div className="space-y-1">
      {blocks.map((block, index) =>
        block.kind === 'title' ? (
          <p key={index} className={cx('font-semibold text-content', index > 0 && 'pt-2')}>{block.text}</p>
        ) : block.kind === 'item' ? (
          <p key={index} className="relative pl-3.5 before:absolute before:left-0 before:content-['•']">{block.text}</p>
        ) : (
          <p key={index}>{block.text}</p>
        ),
      )}
    </div>
  )
}
