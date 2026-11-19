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
 *
 * With two or more `tabs` (2026-11-17, src/sessionTabs.ts) the left part is the session tabs: the one in view keeps
 * its picture, name (renamed on a double-click) and branch; the others are its picture, name and status dot, a click
 * shows them; each tab's own × closes the tab only. The 채팅 / 터미널 pair on the right is the app's one choice, for
 * every session — the tabs are the sessions, the pair is how they are all seen. One tab: the header as before.
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
        title={why ?? t('모든 세션을 채팅으로 보기')}
        onClick={() => { if (!lens.enabled) setTold(true); else if (lens.mode !== 'chat') lens.onMode('chat') }}
      ><ChatGlyph /><span className="w-lens-word">{t('채팅')}</span></button>
      <button
        type="button"
        className={lens.mode === 'terminal' ? 'on' : undefined}
        aria-pressed={lens.mode === 'terminal'}
        title={t('모든 세션을 터미널로 보기')}
        onClick={() => { if (lens.mode !== 'terminal') lens.onMode('terminal') }}
      ><TerminalIcon size={13} /><span className="w-lens-word">{t('터미널')}</span></button>
      <span className="w-lens-note" role="status">{told && why ? why : ''}</span>
    </div>
  )
}

/** A tab other than the one in view: who works it, its name, its status */
export interface TabInfo { sid: string; name: string; sprite: string; picture: SessionHeaderParts['picture']; title?: string; mood?: string }

function pictureOf(picture: SessionHeaderParts['picture'], sprite: string) {
  return picture === 'shell' ? <span className="w-sess-head-pic w-sess-head-shell" aria-hidden="true">&gt;_</span>
    : picture === 'glyph' ? <span className="w-sess-head-pic w-sess-head-glyph" aria-hidden="true"><TerminalIcon size={14} /></span>
    : <img className="w-sess-head-pic" src={sprite} alt="" draggable={false} />
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
  /** The session tabs (two or more: the tab row; absent or one: the header as before) */
  tabs?: TabInfo[]
  activeTab?: string
  onTab?(sid: string): void
  onTabClose?(sid: string): void
  /** A pane of the split view (src/splitPanes.ts): its × closes the pane, the session goes on */
  paneClose?: boolean
}> = ({ parts, sprite, cwd, renaming, onRenameStart, onRenameCommit, onRenameCancel, closing, onClose, onCloseCancel, lens, chatTools, tabs, activeTab, onTab, onTabClose, paneClose }) => {
  const head = (
    <>
    {pictureOf(parts.picture, sprite)}
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
    </>
  )
  const tabbed = !!tabs && tabs.length >= 2
  return (
  <div className={`w-sess-head${tabbed ? ' tabbed' : ''}`} title={cwd || undefined}>
    {tabbed ? (
      <div className="w-sess-tabs" role="tablist" aria-label={t('세션 탭')}>
        {tabs!.map(tb => tb.sid === activeTab ? (
          <div key={tb.sid} className="w-sess-tab on" role="tab" aria-selected="true">
            {head}
            <button className="w-sess-tab-x" onClick={() => onTabClose?.(tb.sid)} title={t('탭 닫기 (세션은 계속 돌아요)')} aria-label={t('탭 닫기')}>×</button>
          </div>
        ) : (
          <div key={tb.sid} className={`w-sess-tab mood-${tb.mood ?? 'idle'}`} role="tab" aria-selected="false" tabIndex={0} title={tb.title}
            onClick={() => onTab?.(tb.sid)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTab?.(tb.sid) } }}>
            {pictureOf(tb.picture, tb.sprite)}
            <span className="w-sess-tab-name">{tb.name}</span>
            <i className="w-sess-tab-dot" aria-hidden="true" />
            <button className="w-sess-tab-x" onClick={e => { e.stopPropagation(); onTabClose?.(tb.sid) }} title={t('탭 닫기 (세션은 계속 돌아요)')} aria-label={`${t('탭 닫기')}: ${tb.name}`}>×</button>
          </div>
        ))}
      </div>
    ) : <>
      {head}
      {parts.project && <span className="w-sess-head-proj">{parts.project}</span>}
    </>}
    <span className="w-sess-head-spacer" />
    {chatTools && <div className="w-chat-tools">{chatTools}</div>}
    {lens && <LensSwitch lens={lens} />}
    <button
      className={`w-sess-head-close${closing ? ' confirm' : ''}`}
      onClick={onClose}
      onMouseLeave={() => closing && onCloseCancel()}
      title={paneClose ? t('칸 닫기 (세션은 계속 돌아요)') : closing ? t('한 번 더 누르면 세션을 닫아요') : t('세션 닫기')}
      aria-label={paneClose ? t('칸 닫기') : t('세션 닫기')}
    >{closing ? t('닫기') : '×'}</button>
  </div>
  )
}

export default SessionHeader
