/**
 * The user's message in the chat view (the lab's `.msg-user`): a quiet block on the
 * right, the text as typed (line breaks kept, never markdown; an `@path` drawn as a file badge), and the time under it.
 * Pictures: the thumbnails of images sent from this composer in this run (a click shows
 * one large), else "이미지 n" (no picture data ever comes back from main).
 *
 * A message sent from the composer and not yet in the session's record is a provisional
 * bubble (src/chat/outbox.ts): "보내는 중…" while it goes, and, when the record does not show
 * it after a while, "기록에서 아직 보이지 않아요" with 터미널에서 확인하기 and 지우기. It never
 * disappears without the record's line taking its place, or the user letting it go.
 */

import React from 'react'
import { t } from '../../i18n'
import type { UserItem } from '../../chat/types'
import { outboxFor } from '../../chat/outbox'
import { useChatContext } from './context'
import { FileRef } from './FileChips'
import { leadingRefs, splitMentions } from '../../chat/mentions'

export const UserMessage: React.FC<{ item: UserItem; time: string | null }> = ({ item, time }) => {
  const { id, thumbs, openImage, onTerminal } = useChatContext()
  const pics = thumbs?.(item.id) ?? []
  // the files the composer's badges sent (`@path` first): pills over the bubble, as pictures are, not in its text
  const { refs, body } = leadingRefs(item.text)
  return (
    <div className={`chat-user${item.pending ? ` pending ${item.pending}` : ''}`}>
      {pics.length > 0
        ? (
          <div className="chat-user-thumbs">
            {pics.map((url, i) => (
              <button key={url} type="button" className="chat-thumb" onClick={e => openImage?.(url, t('붙여넣은 이미지 {n}', { n: i + 1 }), e.currentTarget)} aria-label={`${t('크게 보기')}: ${t('붙여넣은 이미지 {n}', { n: i + 1 })}`} title={t('크게 보기')}>
                <img src={url} alt="" draggable={false} />
              </button>
            ))}
          </div>
        )
        : item.images > 0 && <span className="chat-img-chip">{t('이미지 {n}', { n: item.images })}</span>}
      {refs.length > 0 && <div className="chat-user-files">{refs.map(f => <FileRef key={f} path={f} />)}</div>}
      {body.trim() && <div className="chat-bubble">{splitMentions(body).map((g, i) => g.kind === 'file' ? <FileRef key={i} path={g.path} /> : g.text)}</div>}
      {item.truncated && <span className="chat-time">{t('글이 길어서 앞부분만 보여요. 나머지는 터미널에서 보세요')}</span>}
      {item.pending === 'sending' && <span className="chat-pending">{t('보내는 중…')}</span>}
      {item.pending === 'unconfirmed' && (
        // (it does not float here for good: the user looks in the terminal, or lets it go)
        <span className="chat-pending" role="status">
          <span>{t('기록에서 아직 보이지 않아요')}</span>
          <button type="button" className="chat-link-btn" onClick={onTerminal}>{t('터미널에서 확인하기')}</button>
          <button type="button" className="chat-link-btn" onClick={() => { if (item.local) outboxFor(id).dismiss(item.local) }}>{t('지우기')}</button>
        </span>
      )}
      {time && !item.pending && <span className="chat-time">{time}</span>}
    </div>
  )
}

export default UserMessage
