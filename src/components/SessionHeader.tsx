/**
 * SessionHeader — the bar above the terminal names the session in view, now that the
 * session tabs are gone (the left list, or the folded rail, switches sessions): its
 * picture (the Pokémon; in 업무 모드 a plain glyph; a shell's prompt), its name, the
 * folder's git branch and the project. The name renames on a double-click and the ×
 * closes, both through the same state and functions as the list's rows (Widget.tsx),
 * so they work with the left panel folded too.
 *
 * With `lens` (a Claude Code session while the chat view is on: src/chat/lensMode.ts) a
 * 채팅 / 터미널 pair sits before the ×. Without it the markup is exactly as it was.
 * `chatTools` (only while the chat is shown: the density menu and the changes button) sit
 * before the pair, so the pair and the × keep their place when they come and go. Without them
 * the markup is exactly as it was.
 */

import React, { useEffect, useState } from 'react'
import { TerminalIcon } from './Icons'
import { t } from '../i18n'
import type { SessionHeaderParts } from '../sessionList'

export interface LensProps {
  mode: 'chat' | 'terminal'
  enabled: boolean
  /** Why 채팅 cannot be chosen (a TerminalInfo.chat value) */
  reason: string | null
  onMode(m: 'chat' | 'terminal'): void
}

/** Why a session cannot be shown as chat (the flip's tooltip) */
export const LENS_REASON: Record<string, string> = {
  unarmed: '이 세션은 채팅 보기를 켜기 전에 열렸어요. 다시 열면 채팅으로 볼 수 있어요',
  version: '이 Claude Code 버전에서는 아직 채팅 보기를 쓸 수 없어요',
  starting: '채팅 보기를 준비하는 중이에요',
  // (the hooks' endpoint could not listen: turning the setting off and on tries again)
  failed: '채팅 보기를 준비하지 못했어요',
}

const ChatGlyph = () => (
  <svg className="ico" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z" /></svg>
)

/** 채팅 · 터미널: the session seen as a conversation, or its real terminal (which stays open either way) */
export const LensSwitch: React.FC<{ lens: LensProps }> = ({ lens }) => {
  const why = lens.reason ? t(LENS_REASON[lens.reason] ?? LENS_REASON.unarmed) : undefined
  // a click on the disabled 채팅 says why, for a few seconds, under the pair (and to a screen reader)
  const [told, setTold] = useState(false)
  useEffect(() => { if (!told) return; const timer = setTimeout(() => setTold(false), 4000); return () => clearTimeout(timer) }, [told])
  useEffect(() => { if (lens.enabled) setTold(false) }, [lens.enabled])
  return (
    <div className="w-lens" role="group" aria-label={t('보기 방식')}>
      <button
        type="button"
        className={lens.mode === 'chat' ? 'on' : undefined}
        aria-pressed={lens.mode === 'chat'}
        aria-disabled={lens.enabled ? undefined : true}
        title={why ?? t('채팅')}
        onClick={() => { if (!lens.enabled) setTold(true); else if (lens.mode !== 'chat') lens.onMode('chat') }}
      ><ChatGlyph /><span className="w-lens-word">{t('채팅')}</span></button>
      <button
        type="button"
        className={lens.mode === 'terminal' ? 'on' : undefined}
        aria-pressed={lens.mode === 'terminal'}
        title={t('터미널')}
        onClick={() => { if (lens.mode !== 'terminal') lens.onMode('terminal') }}
      ><TerminalIcon size={13} /><span className="w-lens-word">{t('터미널')}</span></button>
      <span className="w-lens-note" role="status">{told && why ? why : ''}</span>
    </div>
  )
}

export const SessionHeader: React.FC<{
  parts: SessionHeaderParts
  sprite: string
  /** The session's folder: the header's tooltip */
  cwd?: string
  renaming: boolean
  onRenameStart(): void
  onRenameCommit(value: string): void
  onRenameCancel(): void
  /** The × waits for a second click ("닫기") */
  closing: boolean
  onClose(): void
  onCloseCancel(): void
  /** The 채팅 / 터미널 flip (absent: the header as before) */
  lens?: LensProps
  /** The chat's own tools, before the flip (only while the chat is shown; absent: the header as before) */
  chatTools?: React.ReactNode
}> = ({ parts, sprite, cwd, renaming, onRenameStart, onRenameCommit, onRenameCancel, closing, onClose, onCloseCancel, lens, chatTools }) => (
  <div className="w-sess-head" title={cwd || undefined}>
    {parts.picture === 'shell' ? <span className="w-sess-head-pic w-sess-head-shell" aria-hidden="true">&gt;_</span>
      : parts.picture === 'glyph' ? <span className="w-sess-head-pic w-sess-head-glyph" aria-hidden="true"><TerminalIcon size={14} /></span>
      : <img className="w-sess-head-pic" src={sprite} alt="" draggable={false} />}
    {renaming ? (
      <input
        className="w-sess-head-rename"
        autoFocus
        defaultValue={parts.name ?? ''}
        placeholder={t('새 세션')}
        maxLength={40}
        aria-label={t('세션 이름 바꾸기')}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) onRenameCommit(e.currentTarget.value)
          if (e.key === 'Escape') onRenameCancel()
        }}
        onBlur={e => onRenameCommit(e.currentTarget.value)}
      />
    ) : (
      <span className="w-sess-head-name" title={t('더블클릭해서 세션 이름 바꾸기')} onDoubleClick={onRenameStart}>{parts.name ?? t('새 세션')}</span>
    )}
    {parts.branch && <span className="w-row-branch w-sess-head-branch" title={t('git 브랜치')}>{parts.branch}</span>}
    {parts.project && <span className="w-sess-head-proj">{parts.project}</span>}
    <span className="w-sess-head-spacer" />
    {chatTools && <div className="w-chat-tools">{chatTools}</div>}
    {lens && <LensSwitch lens={lens} />}
    <button
      className={`w-sess-head-close${closing ? ' confirm' : ''}`}
      onClick={onClose}
      onMouseLeave={() => closing && onCloseCancel()}
      title={closing ? t('한 번 더 누르면 세션을 닫아요') : t('세션 닫기')}
      aria-label={t('세션 닫기')}
    >{closing ? t('닫기') : '×'}</button>
  </div>
)

export default SessionHeader
