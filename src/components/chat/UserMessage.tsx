/**
 * The user's message in the chat view: a quiet block on the
 * right, the text as typed (line breaks kept, never markdown; an `@path` drawn as a file badge), and the time under it.
 * Pictures: the thumbnails of images sent from this composer in this run (a click shows
 * one large), else "이미지 n" (no picture data ever comes back from main).
 *
 * A message sent from the composer and not yet in the session's record is a provisional
 * bubble (src/chat/outbox.ts): "보내는 중…" while it goes, then plain until the record's line takes its place
 * (a prompt another plugin's hook blocked: the record's notice says so instead).
 */

import React from 'react'
import { t } from '../../i18n'
import type { UserItem } from '../../chat/types'
import { useChatContext } from './context'
import { PictureRow, type PictureSource } from './Pictures'
import { FileRef } from './FileChips'
import { FullButton } from './FullView'
import { leadingRefs, splitMentions } from '../../chat/mentions'

/** A sent message's pictures, read again from its transcript line when the row is drawn */
const SentPictures: React.FC<{ itemId: string; count: number; load(itemId: string, index: number): Promise<{ type: string; bytes: Uint8Array } | null> }> = ({ itemId, count, load }) => {
  const keys = React.useMemo(() => Array.from({ length: Math.min(count, 12) }, (_, i) => String(i)), [count])
  const source = React.useMemo<PictureSource>(() => ({
    load: k => load(itemId, Number(k)),
    caption: k => t('붙여넣은 이미지 {n}', { n: Number(k) + 1 }),
  }), [itemId, load])
  return <PictureRow keys={keys} source={source} className="chat-user-thumbs" />
}

export const UserMessage: React.FC<{ item: UserItem; time: string | null }> = ({ item, time }) => {
  const { thumbs, openImages, loadUserImage } = useChatContext()
  const pics = thumbs?.(item.id) ?? []
  // the files the composer's badges sent (`@path` first): pills over the bubble, as pictures are, not in its text
  const { refs, body } = leadingRefs(item.text)
  return (
    <div className={`chat-user${item.pending ? ` pending ${item.pending}` : ''}`}>
      {pics.length > 0
        ? (
          <div className="chat-user-thumbs">
            {pics.map((url, i) => (
              <button key={url} type="button" className="chat-thumb" onClick={e => openImages?.(pics.map((u, k) => ({ url: u, caption: t('붙여넣은 이미지 {n}', { n: k + 1 }) })), i, e.currentTarget)} aria-label={`${t('크게 보기')}: ${t('붙여넣은 이미지 {n}', { n: i + 1 })}`} title={t('크게 보기')}>
                <img src={url} alt="" draggable={false} />
              </button>
            ))}
          </div>
        )
        // (after a restart this run's copies are gone: read again from the message's own transcript line)
        : item.images > 0 && (loadUserImage && !item.pending
          ? <SentPictures itemId={item.id} count={item.images} load={loadUserImage} />
          : <span className="chat-img-chip">{t('이미지 {n}', { n: item.images })}</span>)}
      {refs.length > 0 && <div className="chat-user-files">{refs.map(f => <FileRef key={f} path={f} />)}</div>}
      {body.trim() && <div className="chat-bubble">{splitMentions(body).map((g, i) => g.kind === 'file' ? <FileRef key={i} path={g.path} /> : g.text)}</div>}
      {item.truncated && <span className="chat-time">{t('글이 길어서 앞부분만 보여요')} <FullButton itemId={item.id} title={t('보낸 메시지 전체')} /></span>}
      {item.pending === 'sending' && <span className="chat-pending">{t('보내는 중…')}</span>}
      {time && !item.pending && <span className="chat-time">{time}</span>}
    </div>
  )
}

export default UserMessage
