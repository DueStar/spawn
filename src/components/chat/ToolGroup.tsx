/**
 * Finished reads and searches in a row, folded into one line ("파일 3개 읽음 ·
 * 검색 2회"). Opening it lists each file (with its line count when known) and each
 * pattern. Only finished, plain reads and searches ever get here (src/chat/rows.ts): a
 * call waiting on the user, a failure or a running call is never folded.
 */

import React from 'react'
import { t, tSense } from '../../i18n'
import { groupLabel } from '../../chat/toolLabel'
import type { ToolItem } from '../../chat/types'
import { ChevIcon, FilesIcon, SearchIcon } from './ChatIcons'
import { initialOpen } from '../../chat/density'
import { useChatContext, useRowOpen } from './context'

const base = (f: string) => f.split(/[\\/]/).pop() || f

/** One line of the open group: what was read or looked for, and what came of it */
function lineOf(it: ToolItem): [string, string] {
  if (it.tool === 'Grep') return [`"${it.input.pattern ?? ''}"`, it.input.path ?? '']
  if (it.tool === 'Glob' || it.tool === 'LS') return [it.input.pattern ?? it.input.path ?? '', it.output ? tSense('{n}줄', 'chat', { n: it.output.lines }) : '']
  return [it.input.file ?? '', it.output?.lines ? tSense('{n}줄', 'chat', { n: it.output.lines }) : '']
}

/**
 * A group's own open state: never its first call's (the group takes that row's key for its place, but a
 * Grep row the user opened must not turn into an open group when a second read joins it)
 */
export const groupOpenKey = (groupKey: string) => `group:${groupKey}`

export const ToolGroup: React.FC<{ groupKey: string; items: ToolItem[]; files: number; searches: number }> = ({ groupKey, items, files, searches }) => {
  const { density } = useChatContext()
  // (전부 opens it until the user closes it)
  const [open, setOpen] = useRowOpen(groupOpenKey(groupKey), initialOpen(density ?? 'default', 'group'))
  const detail = items.map(it => (it.tool === 'Read' || it.tool === 'NotebookRead' ? base(it.input.file ?? '') : it.tool === 'Grep' ? `"${it.input.pattern ?? ''}"` : it.input.pattern ?? '')).filter(Boolean).join(', ')
  return (
    <div className={`chat-tool chat-group${open ? ' open' : ''}`}>
      <div className="chat-tool-head">
        <button type="button" className="chat-tool-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="chat-tool-chev" aria-hidden="true"><ChevIcon /></span>
          <span className="chat-tool-ico">{files ? <FilesIcon /> : <SearchIcon />}</span>
          <span className="chat-tool-label">{groupLabel(files, searches, t)}</span>
          {detail && <span className="chat-tool-detail mono" title={detail}>{detail}</span>}
        </button>
      </div>
      {open && (
        <div className="chat-tool-body chat-group-body">
          {items.map(it => {
            const [a, b] = lineOf(it)
            return <div key={it.id} className="chat-ln"><span className="hit">{a}</span>{b && <span>{b}</span>}</div>
          })}
        </div>
      )}
    </div>
  )
}

export default ToolGroup
