/**
 * What Claude Code itself queued while it works, attached above the
 * composer's box: a grey dot, 대기 중 N, the first prompt's text. A click opens the whole list
 * (oldest first; the record gives at most three texts, the rest said as 외 N개) and closes it
 * again. Display only (no 지금 보내기, no 빼기 — Claude Code's queue is
 * not edited from outside). The text comes from the session's record (src/chat/types.ts
 * LensStatus.queued), never from what this page sent.
 */

import React, { useEffect, useState } from 'react'
import { t } from '../../i18n'
import type { LensStatus } from '../../chat/types'
import { ChevDownIcon } from './ChatIcons'

export const QueueStrip: React.FC<{ status: LensStatus | null }> = ({ status }) => {
  const n = status?.queuedCount ?? 0
  const queued = status?.queued ?? []
  const first = queued[0]
  const [open, setOpen] = useState(false)
  // the queue emptied: the next one starts folded
  useEffect(() => { if (!n) setOpen(false) }, [n])
  const more = n - queued.length
  return (
    <div className="chat-queue-live" aria-live="polite">
      {n > 0 && first && (
        <div className={`chat-queue-wrap${open ? ' open' : ''}`}>
          {open && (
            <ol className="chat-queue-list" aria-label={t('대기 중인 메시지')}>
              {queued.map((q, i) => (
                <li key={i}><span className="chat-queue-n">{i + 1}</span><span className="chat-queue-full">{q.text}{q.truncated ? '…' : ''}</span></li>
              ))}
              {more > 0 && <li className="chat-queue-more">{t('외 {n}개', { n: more })}</li>}
            </ol>
          )}
          <button type="button" className="chat-queue" aria-expanded={open} onClick={() => setOpen(!open)}
            title={open ? t('접기') : t('지금 하는 일이 끝나면 이어서 보내요 · 눌러서 목록 보기')}>
            <span className="chat-queue-label">{t('대기 중 {n}', { n })}</span>
            <span className="chat-queue-text">{open ? '' : `${first.text}${first.truncated ? '…' : ''}`}</span>
            <span className="chat-queue-chev" aria-hidden="true"><ChevDownIcon /></span>
          </button>
        </div>
      )}
    </div>
  )
}

export default QueueStrip
