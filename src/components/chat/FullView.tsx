/**
 * "전체 보기" (2026-11-17): an item the chat shows cut (an answer over its cap, a long message, a command's output
 * past 200 lines) read again whole from the transcript (electron/chatFull.cjs) and shown over the conversation,
 * with 복사 and 닫기 — in place of "the rest is in the terminal". An answer reads as prose, an output as text.
 */

import React, { useEffect, useMemo, useRef } from 'react'
import { t } from '../../i18n'
import { parseMarkdown } from '../../chat/markdown'
import { CopyButton } from './CodeBlock'
import { Markdown } from './Markdown'
import { useChatContext } from './context'

export interface FullState { title: string; loading: boolean; text?: string; md?: boolean; truncated?: boolean; error?: 'gone' | 'unknown' | 'none' }

/** The button that asks for the whole item */
export const FullButton: React.FC<{ itemId: string; title: string; label?: string }> = ({ itemId, title, label }) => {
  const { openFull } = useChatContext()
  if (!openFull) return null
  return <button type="button" className="chat-link-btn chat-full-btn" onClick={() => openFull(itemId, title)}>{label ?? t('전체 보기')}</button>
}

const ERRORS: Record<NonNullable<FullState['error']>, string> = {
  gone: '세션 기록에서 다시 읽지 못했어요. 기록이 바뀌었을 수 있어요',
  unknown: '이 항목은 다시 읽을 수 없어요',
  none: '파일 읽기의 내용은 채팅에 싣지 않아요',
}

export const FullView: React.FC<{ state: FullState; onClose(): void }> = ({ state, onClose }) => {
  const { onLink, onPath } = useChatContext()
  const blocks = useMemo(() => (state.text && state.md ? parseMarkdown(state.text) : null), [state.text, state.md])
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { closeRef.current?.focus() }, [])
  return (
    <div className="chat-full" role="dialog" aria-modal="true" aria-label={state.title}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() } }}>
      <div className="chat-full-panel">
        <div className="chat-full-head">
          <b className="chat-full-title">{state.title}</b>
          {state.text !== undefined && <CopyButton text={state.text} label={t('복사')} />}
          <button ref={closeRef} type="button" className="chat-btn" onClick={onClose}>{t('닫기')}</button>
        </div>
        <div className="chat-full-body" tabIndex={0}>
          {state.loading && <p className="chat-full-note">{t('불러오는 중…')}</p>}
          {state.error && <p className="chat-full-note">{t(ERRORS[state.error])}</p>}
          {blocks ? <div className="chat-prose"><Markdown blocks={blocks} onLink={onLink} onPath={onPath} /></div>
            : state.text !== undefined && <pre className="chat-full-pre">{state.text}</pre>}
          {state.truncated && <p className="chat-full-note">{t('2백만 자까지만 보여요')}</p>}
        </div>
      </div>
    </div>
  )
}

export default FullView
