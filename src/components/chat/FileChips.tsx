/**
 * The files picked from the @ menu, as badges over the text, beside the image chips: a file icon, the file's name
 * (the whole path in the tooltip) and × (left out). The text never holds them: the send puts `@path` before the
 * message (src/chat/mentions.ts withRefs), which is what Claude Code reads.
 */

import React from 'react'
import { t } from '../../i18n'
import { baseName } from '../../chat/mentions'
import { FileIcon, XIcon } from './ChatIcons'

export const FileChips: React.FC<{ files: string[]; onRemove(path: string): void }> = ({ files, onRemove }) => {
  if (!files.length) return null
  return (
    <div className="chat-chips chat-fchips">
      {files.map(path => {
        const name = baseName(path)
        return (
          <span key={path} className="chat-fchip" title={path}>
            <span className="chat-fchip-ico"><FileIcon size={13} /></span>
            <span className="chat-fchip-name">{name}</span>
            <button type="button" className="chat-ichip-x" onClick={() => onRemove(path)} aria-label={`${t('빼기')}: ${name}`} title={t('빼기')}><XIcon /></button>
          </span>
        )
      })}
    </div>
  )
}

/** A file in a sent message: the same badge, without ×, inline in the text */
export const FileRef: React.FC<{ path: string }> = ({ path }) => (
  <span className="chat-fref" title={path}><FileIcon size={12} /><span>{baseName(path)}</span></span>
)

/** A file Claude sent: a button that opens it (a page, a PDF or a picture in its viewer; else the editor or its folder) */
export const SentFile: React.FC<{ path: string; onOpen(path: string): void }> = ({ path, onOpen }) => (
  <button type="button" className="chat-fref chat-sent-file" title={`${path} · ${t('눌러서 열기')}`} onClick={() => onOpen(path)}>
    <FileIcon size={12} /><span>{baseName(path)}</span>
  </button>
)

export default FileChips
