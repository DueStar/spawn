/**
 * The composer's / menu (2026-11-19; the @ menu's look and keys: src/components/chat/MentionMenu.tsx): Claude Code's
 * commands, the session's own and its skills, filtered by the letters typed after the / (src/chat/slash.ts). Each row:
 * `/name`, its aliases, its description cut to one line. The textarea keeps the focus: ↑ ↓ move, Enter or Tab puts
 * `/name ` into the draft (never sends), Esc closes the menu only. A click picks too. The list scrolls; the chosen row
 * stays in view.
 */

import React, { useEffect, useRef } from 'react'
import { t } from '../../i18n'
import type { CommandKind, SlashCommand } from '../../chat/slash'
import { RunIcon } from './ChatIcons'

const KIND: Record<Exclude<CommandKind, 'builtin'>, string> = {
  user: '내 명령',
  project: '프로젝트',
  skill: '스킬',
  plugin: '플러그인',
}

export const SlashMenu: React.FC<{ listId: string; commands: SlashCommand[]; sel: number; onPick(i: number): void; onHover(i: number): void }> = ({ listId, commands, sel, onPick, onHover }) => {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const row = box.current?.querySelector<HTMLElement>(`#${CSS.escape(`${listId}-${sel}`)}`)
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [sel, listId])
  return (
    <div className="chat-menu slash" role="listbox" id={listId} aria-label={t('명령')} ref={box}>
      <div className="chat-menu-title" aria-hidden="true">{t('명령')}</div>
      {commands.length
        ? commands.map((c, i) => (
          <div
            key={`${c.kind}:${c.name}`}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === sel}
            className={`chat-mi cmd${i === sel ? ' sel' : ''}`}
            title={c.desc || undefined}
            // (the textarea keeps the focus)
            onMouseDown={e => { e.preventDefault(); onPick(i) }}
            onMouseEnter={() => onHover(i)}
          >
            <RunIcon size={12} />
            <span className="chat-mi-cmd">
              <code>/{c.name}</code>
              {c.aliases && c.aliases.length > 0 && <span className="chat-mi-alias">{c.aliases.map(a => `/${a}`).join(' ')}</span>}
              {c.kind !== 'builtin' && <span className="chat-mi-kind">{t(KIND[c.kind])}</span>}
              {c.desc && <span className="chat-mi-desc">{c.desc}</span>}
            </span>
          </div>
        ))
        : <div className="chat-menu-empty">{t('맞는 명령이 없어요')}</div>}
    </div>
  )
}

export default SlashMenu
