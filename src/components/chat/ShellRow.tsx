/**
 * A `!` command (Claude Code's bash mode) in the chat view: a small terminal block on the right, where the user's
 * own messages sit — `! command` in mono, then what it printed (stderr in the error colour), folded past a few
 * lines. While its output line has not come: 실행 중…. The command and its output also went into Claude's context,
 * as in the terminal.
 */

import React from 'react'
import { t } from '../../i18n'
import type { ShellItem } from '../../chat/types'
import { useRowOpen } from './context'

const FOLD_LINES = 12

export const ShellRow: React.FC<{ item: ShellItem; time: string | null }> = ({ item, time }) => {
  const out = [item.stdout, item.stderr].filter(Boolean).join('\n')
  const lines = out ? out.split('\n').length : 0
  const long = lines > FOLD_LINES
  const [open, setOpen] = useRowOpen(item.id, false)
  const shown = (s: string | undefined) => (s && long && !open ? s.split('\n').slice(0, FOLD_LINES).join('\n') : s)
  const stdout = shown(item.stdout)
  // (folded: stderr shows only once stdout left room for it)
  const stderr = long && !open && (item.stdout?.split('\n').length ?? 0) >= FOLD_LINES ? undefined : shown(item.stderr)
  return (
    <div className="chat-user chat-shell">
      <div className="chat-shell-box">
        <div className="chat-shell-cmd"><b aria-hidden="true">!</b><span>{item.command}</span></div>
        {item.state === 'running' && <div className="chat-shell-run">{t('실행 중…')}</div>}
        {item.state === 'done' && !out && <div className="chat-shell-run">{t('출력 없음')}</div>}
        {(stdout || stderr) && (
          <pre className="chat-shell-out" tabIndex={0} aria-label={t('명령 결과')}>
            {stdout}{stdout && stderr ? '\n' : ''}{stderr && <span className="chat-shell-err">{stderr}</span>}
          </pre>
        )}
        {long && (
          <button type="button" className="chat-link-btn chat-shell-more" onClick={() => setOpen(!open)}>
            {open ? t('접기') : t('{n}줄 더 보기', { n: lines - FOLD_LINES })}
          </button>
        )}
        {item.truncated && <p className="chat-tool-note">{t('출력이 길어서 앞부분만 보여요. 나머지는 터미널에서 보세요')}</p>}
      </div>
      {time && <span className="chat-time">{time}</span>}
    </div>
  )
}

export default ShellRow
