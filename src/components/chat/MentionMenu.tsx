/**
 * The composer's @ menu: file names from the
 * session's own folder (main reads names only: electron/chatFiles.cjs), at most 8. The
 * textarea keeps the focus: ↑ ↓ move, Enter or Tab puts `@path ` into the draft, Esc closes
 * the menu only (src/chat/composerKeys.ts). A click picks too.
 */

import React from 'react'
import { t } from '../../i18n'
import { FileIcon } from './ChatIcons'

export const MENU_ROWS = 8

export const MentionMenu: React.FC<{ listId: string; files: string[]; sel: number; onPick(i: number): void; onHover(i: number): void }> = ({ listId, files, sel, onPick, onHover }) => (
  <div className="chat-menu" role="listbox" id={listId} aria-label={t('파일 멘션')}>
    <div className="chat-menu-title" aria-hidden="true">{t('파일')}</div>
    {files.length
      ? files.slice(0, MENU_ROWS).map((f, i) => (
        <div
          key={f}
          id={`${listId}-${i}`}
          role="option"
          aria-selected={i === sel}
          className={`chat-mi${i === sel ? ' sel' : ''}`}
          // (the textarea keeps the focus)
          onMouseDown={e => { e.preventDefault(); onPick(i) }}
          onMouseEnter={() => onHover(i)}
        >
          <FileIcon size={12} />
          <code>{f}</code>
        </div>
      ))
      : <div className="chat-menu-empty">{t('맞는 파일이 없어요')}</div>}
  </div>
)

export default MentionMenu
