/**
 * "이 세션을 채팅으로 읽지 못하고 있어요": whenever the lens is in
 * doubt — the record's shape, the canary, a missing or stalled or rewritten record, an
 * unchecked version, an unclear mapping, a stopped reader — the view says so, why, and
 * offers the terminal (and 다시 읽기). Wrong or stale is the worst failure, so every
 * reason the lens gives is shown; the conversation under it is dimmed, never hidden.
 */

import React from 'react'
import { t } from '../../i18n'
import type { BannerReason } from '../../chat/types'
import { TerminalIcon } from '../Icons'
import { WarnIcon } from './ChatIcons'

/** Each reason's line (ko keys, src/locales/chat.ts) */
export const BANNER_REASON: Record<BannerReason, string> = {
  schema: '세션 기록의 모양이 예상과 달라요. 작업은 터미널에서 그대로 진행 중이에요',
  canary: '방금 끝난 답이 세션 기록에서 보이지 않아요',
  missing: '세션 기록 파일을 찾지 못했어요',
  stalled: '세션 기록이 30초 넘게 갱신되지 않아요',
  rewrite: '세션 기록이 다시 쓰였어요. 다시 읽으면 처음부터 맞춰 볼게요',
  version: '이 Claude Code 버전({version})은 채팅 보기에서 확인하지 않았어요',
  mapping: '어느 세션의 기록인지 확실하지 않아요',
  worker: '채팅을 읽는 부분이 멈췄어요',
  // (the page's own: chat.open found the session not armed, a race the flip should have kept out)
  unarmed: '이 세션은 채팅 보기를 켜기 전에 열렸어요. 다시 열면 채팅으로 볼 수 있어요',
}

/** The line for a reason; one the page does not know still says something */
export function bannerLine(reason: string, version: string | null): string {
  const key = (BANNER_REASON as Record<string, string>)[reason]
  return key ? t(key, { version: version ?? '?' }) : t('여기서 보여 줄 수 없는 내용이 있어요')
}

export const ChatBanner: React.FC<{ reason: string; version: string | null; onTerminal(): void; onReload(): void }> = ({ reason, version, onTerminal, onReload }) => (
  <div className="chat-banner" role="status">
    <span className="chat-banner-ico"><WarnIcon /></span>
    <div className="chat-banner-text">
      <b>{t('이 세션을 채팅으로 읽지 못하고 있어요')}</b>
      <span>{bannerLine(reason, version)}</span>
    </div>
    <div className="chat-banner-acts">
      <button type="button" className="chat-btn solid" onClick={onTerminal}><TerminalIcon size={13} />{t('터미널로 보기')}</button>
      <button type="button" className="chat-btn" onClick={onReload}>{t('다시 읽기')}</button>
    </div>
  </div>
)

export default ChatBanner
