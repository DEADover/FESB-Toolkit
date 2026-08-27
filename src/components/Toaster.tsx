import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { CheckCircle, Warning, WarningCircle, X, type Icon } from '@phosphor-icons/react'

import { useI18n } from '../i18n'
import { ActionLink, cx, FOCUS_RING } from './ui'

/**
 * Всплывающие уведомления.
 *
 * Полоса под шапкой для этого не годилась: она сдвигала всё содержимое вниз
 * и оставалась висеть, пока её не закроют, — а сообщение вроде «не удалось
 * подключиться» нужно прочитать один раз. Всплывающее окно ничего не двигает
 * и уходит само.
 *
 * Само не уходит только то, на что наведён курсор: читать длинную причину
 * отказа под тикающий таймер — плохо.
 */

export interface Toast {
  tone: 'danger' | 'warn' | 'ok'
  title: string
  /** Подробность: причина отказа, имя файла, что угодно уточняющее. */
  text?: string
  /** Одно действие: «Настроить», «Открыть», «Повторить». */
  action?: { label: string; onClick: () => void }
}

interface Shown extends Toast {
  id: number
}

/** Сколько уведомление держится, если его не трогать. */
const LIFETIME: Record<Toast['tone'], number> = {
  danger: 9000,
  warn: 7000,
  ok: 4000,
}

/** Больше трёх на экране — уже стена; старые уходят, не дожидаясь срока. */
const MAX_SHOWN = 3

const ToastContext = createContext<(toast: Toast) => void>(() => {})

/** Показать уведомление. Возвращается функция, а не объект: вызывают её одну. */
export function useToast() {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Shown[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const show = useCallback((toast: Toast) => {
    const id = nextId.current++
    setToasts((prev) => [...prev.slice(-(MAX_SHOWN - 1)), { ...toast, id }])
  }, [])

  const value = useMemo(() => show, [show])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Правый нижний угол: пилюля подключения и кнопки живут вверху,
          и перекрывать их уведомлением незачем. */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[22rem] flex-col gap-2">
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onClose={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

const TONES: Record<Toast['tone'], { box: string; icon: Icon; mark: string }> = {
  danger: { box: 'border-negative/40 bg-negative/12 text-negative', icon: WarningCircle, mark: 'text-negative' },
  warn: { box: 'border-caution/40 bg-caution/12 text-caution', icon: Warning, mark: 'text-caution' },
  ok: { box: 'border-positive/40 bg-positive/12 text-positive', icon: CheckCircle, mark: 'text-positive' },
}

function ToastCard({ toast, onClose }: { toast: Shown; onClose: () => void }) {
  const { t } = useI18n()
  const [held, setHeld] = useState(false)
  const tone = TONES[toast.tone]
  const Glyph = tone.icon

  useEffect(() => {
    if (held) return
    const timer = setTimeout(onClose, LIFETIME[toast.tone])
    return () => clearTimeout(timer)
  }, [held, onClose, toast.tone])

  return (
    <div
      role="status"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      className={cx(
        'pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3.5 py-3 shadow-2xl backdrop-blur-sm',
        'animate-toast-in',
        tone.box,
      )}
    >
      <Glyph size={16} weight="fill" className={cx('mt-px shrink-0', tone.mark)} />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium">{toast.title}</div>
        {toast.text && (
          // Причина отказа бывает длинной; целиком она остаётся в подсказке.
          <div className="mt-0.5 line-clamp-3 break-words text-[11.5px] opacity-90" title={toast.text}>
            {toast.text}
          </div>
        )}
        {toast.action && (
          <div className="mt-1.5">
            <ActionLink onClick={() => { onClose(); toast.action?.onClick() }}>{toast.action.label}</ActionLink>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('action.close')}
        title={t('action.close')}
        className={cx('-mr-1 grid size-5 shrink-0 place-items-center rounded transition hover:bg-current/15', FOCUS_RING)}
      >
        <X size={11} weight="bold" />
      </button>
    </div>
  )
}
