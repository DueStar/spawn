/**
 * The chat view's safety net: a row that throws (a shape a future Claude Code writes that this
 * page does not expect) takes down only the chat pane, never the window. The terminals and
 * the session list sit outside it, so they keep working; the pane says it could not draw and
 * offers the terminal. It starts afresh for another session (Widget.tsx keys it by terminal).
 */

import React from 'react'
import { t } from '../i18n'
import { TerminalIcon } from './Icons'

/** `where`: a class for the failure's box besides w-chat-failed (the 변경 사항 panel's column: only that column says it) */
interface Props { onTerminal(): void; children: React.ReactNode; where?: string }

let logged = false

export class ChatBoundary extends React.Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    if (logged) return
    logged = true
    console.warn('chat view: a row could not be drawn', error instanceof Error ? error.message : String(error))
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className={`w-chat-failed${this.props.where ? ` ${this.props.where}` : ''}`} role="status">
        <span>{t('채팅 보기를 그리지 못했어요')}</span>
        <button type="button" onClick={this.props.onTerminal}><TerminalIcon size={13} />{t('터미널로 보기')}</button>
      </div>
    )
  }
}

export default ChatBoundary
