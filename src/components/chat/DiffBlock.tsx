/**
 * A file edit in the chat view: a head with the file (a button that
 * opens it in the code editor at its first changed line), +N −N, and the kind word for a
 * new file; then the first 8 lines of the change, the rest behind "{n}줄 더 보기". Lines
 * the lens did not send (over its cap) are named on a last line: "{n}줄은 터미널에서 보세요".
 * A diff the lens cut (a line or the block's text over its cap) says 잘림 in its head.
 * Built from the transcript's structuredPatch only (electron/chatItems.cjs buildDiff).
 */

import React, { useState } from 'react'
import { t } from '../../i18n'
import { DocToggle, MdDocBody, isMarkdownFile } from './Markdown'
import { isRemotePath } from '../../chat/markdown'
import { initialOpen } from '../../chat/density'
import type { DiffBlock as Diff, DiffLine, ToolItem } from '../../chat/types'
import { EditIcon } from './ChatIcons'
import { useChatContext, useRowOpen } from './context'

/** Lines shown before "더 보기" */
export const DIFF_PREVIEW = 8

type Line = DiffLine | { t: 'gap' }

/** A window with a panel on its right, small, after the counts */
const PanelGlyph = () => (
  <svg className="ico" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="2" /><path d="M9.5 3v10" /></svg>
)

export const DiffBlock: React.FC<{ item: ToolItem; diff: Diff }> = ({ item, diff }) => {
  const { onPath, onLink, openChanges, density } = useChatContext()
  // (전부 shows every line until the user folds it)
  const [all, setAll] = useRowOpen(`${item.id}:diff`, initialOpen(density ?? 'default', 'diff'))
  const lines: Line[] = []
  diff.hunks.forEach((h, i) => { if (i > 0) lines.push({ t: 'gap' }); lines.push(...h.lines) })
  const real = lines.filter(l => l.t !== 'gap').length
  const shown = all ? lines : lines.slice(0, DIFF_PREVIEW)
  const more = real - shown.filter(l => l.t !== 'gap').length
  const firstLine = diff.hunks[0]?.newStart || undefined
  // a new markdown file, whole: shown as the document it is (변경 shows the added lines)
  const docText = diff.kind === 'create' && isMarkdownFile(diff.file) && !diff.truncated && !diff.hidden && real > 0
    ? lines.filter((l): l is DiffLine => l.t === '+').map(l => l.text).join('\n') : null
  const [asDiff, setAsDiff] = useState(false)
  return (
    <div className="chat-diff">
      <div className="chat-diff-head">
        <span className="chat-tool-ico"><EditIcon size={13} /></span>
        {diff.kind === 'create' && <span className="chat-diff-kind">{t('새 파일')}</span>}
        {docText !== null && <DocToggle raw={asDiff} onRaw={setAsDiff} other={t('변경')} />}
        {/* a UNC or device path stays text: a click would make Windows connect to that host */}
        {isRemotePath(diff.file)
          ? <span className="chat-diff-file">{diff.file}</span>
          : <button type="button" className="chat-diff-file" title={t('코드 편집기에서 열기 (없으면 폴더에서 보기)')} onClick={() => onPath(diff.file, firstLine)}>{diff.file}</button>}
        {/* a line or the block was cut by the lens (a minified file, a very long line): the counts are whole */}
        {diff.truncated && <span className="chat-diff-cut" title={t('줄이 너무 길어서 일부만 보여요. 전체는 터미널에서 보세요')}>{t('잘림')}</span>}
        {/* the counts open the 변경 사항 panel at this edit (the file name keeps opening the editor) */}
        {openChanges ? (
          <button type="button" className="chat-counts chat-counts-btn" title={t('변경 사항 보기')} aria-label={`+${diff.added} −${diff.removed} · ${t('변경 사항 보기')}`}
            onClick={() => openChanges({ file: diff.file, toolId: item.id })}>
            <span className={diff.added ? 'a' : 'z'}>+{diff.added}</span>
            <span className={diff.removed ? 'd' : 'z'}>−{diff.removed}</span>
            <span className="chat-counts-ico" aria-hidden="true"><PanelGlyph /></span>
          </button>
        ) : (
          <span className="chat-counts" aria-label={`+${diff.added} −${diff.removed}`}>
            <span className={diff.added ? 'a' : 'z'}>+{diff.added}</span>
            <span className={diff.removed ? 'd' : 'z'}>−{diff.removed}</span>
          </span>
        )}
      </div>
      {docText !== null && !asDiff && <div className="chat-diff-doc"><MdDocBody text={docText} raw={false} onLink={onLink} onPath={onPath} /></div>}
      {lines.length > 0 && (docText === null || asDiff) && (
        <div className="chat-diff-body">
          <div className="chat-diff-lines">
            {shown.map((l, i) => l.t === 'gap'
              ? <div key={i} className="chat-dl gap" aria-hidden="true"><span className="no" /><span className="sg" /><span>⋯</span></div>
              : (
                <div key={i} className={`chat-dl${l.t === '+' ? ' add' : l.t === '-' ? ' del' : ''}`}>
                  <span className="no">{l.t === '-' ? l.old : l.new}</span>
                  <span className="sg">{l.t === ' ' ? '' : l.t === '-' ? '−' : '+'}</span>
                  <span className="tx">{l.text}</span>
                </div>
              ))}
          </div>
          {(more > 0 || (all && real > DIFF_PREVIEW)) && (
            <button type="button" className="chat-diff-more" aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? t('접기') : t('{n}줄 더 보기', { n: more })}
            </button>
          )}
          {diff.hidden > 0 && (all || more === 0) && <div className="chat-diff-hidden">{t('{n}줄은 터미널에서 보세요', { n: diff.hidden })}</div>}
        </div>
      )}
    </div>
  )
}

export default DiffBlock
