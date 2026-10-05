import { ArrowCounterClockwise } from '@phosphor-icons/react'

import { useI18n } from '../i18n'
import { ActionLink } from './ui'

/**
 * Строка под итогом правки: изменения записаны в журнал, там их и отменяют.
 *
 * Без неё о журнале узнают, только наткнувшись на него в меню, — а нужен он
 * как раз сразу после операции, когда видно, что сделано не то.
 */
export function JournalHint({ onOpenJournal }: { onOpenJournal?: () => void }) {
  const { t } = useI18n()
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-content-subtle">
      <ArrowCounterClockwise size={13} weight="bold" className="shrink-0" />
      {t('journal.hint')}
      {onOpenJournal && <ActionLink onClick={onOpenJournal}>{t('journal.hint.open')}</ActionLink>}
    </p>
  )
}
