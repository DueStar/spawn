/**
 * What Claude Code itself queued while it works (the lab's `.queue`), attached above the
 * composer's box: a grey dot, 대기 중 N, the first prompt's text. Display only (the plan's
 * Decision 7: no 지금 보내기, no 빼기 — Claude Code's queue is not edited from outside).
 * The text comes from the session's record (src/chat/types.ts LensStatus.queued), never
 * from what this page sent.
 */

import React from 'react'
import { t } from '../../i18n'
import type { LensStatus } from '../../chat/types'

export const QueueStrip: React.FC<{ status: LensStatus | null }> = ({ status }) => {
  const n = status?.queuedCount ?? 0
  const first = status?.queued?.[0]
  return (
    <div className="chat-queue-live" aria-live="polite">
      {n > 0 && first && (
        <div className="chat-queue" title={t('지금 하는 일이 끝나면 이어서 보내요')}>
          <span className="chat-queue-label">{t('대기 중 {n}', { n })}</span>
          <span className="chat-queue-text">{first.text}{first.truncated ? '…' : ''}</span>
        </div>
      )}
    </div>
  )
}

export default QueueStrip
