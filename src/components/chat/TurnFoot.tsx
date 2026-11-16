/**
 * The turn summary (Phase 5, the lab's `.turn-foot`, calm-lab app.css 660–663, app.js 389): one quiet line
 * after a finished turn. Its time (turn_duration), then — only when the whole turn is loaded — its tool calls
 * and the files its edits changed, the step count when src/chat/steps.ts could know it exactly (never in
 * 업무 모드), and the answer's 복사, which takes over the per-row copy of the turn's texts (Decision 10).
 * A count that cannot be known is left out, never guessed.
 */

import React, { useSyncExternalStore } from 'react'
import { josa, t, tSense } from '../../i18n'
import { footCopy, type FootRow } from '../../chat/rows'
import { formatDuration } from '../../chat/toolLabel'
import { CopyButton } from './CodeBlock'
import { useChatContext } from './context'

const noSub = () => () => {}

/** The lab's step glyph (app.js `steps`): two paw prints, drawn in the line's own colour */
const PawIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 2.5c1.2 0 1.8 1.4 1.8 3S6.2 9 5.2 9 3.4 7.6 3.4 6 3.8 2.5 5 2.5zM3.7 10.5h2.8l-.3 2c-.2.9-2.2.9-2.3 0zM11 4.5c1.2 0 1.6 1.4 1.6 3s-.6 3.3-1.6 3.3-1.8-1.4-1.8-3 .6-3.3 1.8-3.3zM9.6 12.3h2.8l-.3 1.6c-.2.9-2.2.9-2.3 0z" />
  </svg>
)

export const TurnFoot: React.FC<{ row: FootRow; name: string }> = ({ row, name }) => {
  const { workMode, stepsFor, stepsSubscribe } = useChatContext()
  const id = row.item.id
  const get = () => (stepsFor ? stepsFor(id) : null)
  const steps = useSyncExternalStore(stepsSubscribe ?? noSub, get, get)
  const d = formatDuration(row.item.durationMs)
  const copy = row.whole && row.texts.length ? footCopy(row) : null
  return (
    <div className="chat-foot">
      <span>{t(d.text, d.vars)}</span>
      {row.whole && row.tools !== null && <span>{t('도구 {n}회', { n: row.tools })}</span>}
      {row.whole && row.files !== null && row.files > 0 && <span>{t('파일 {n}개 바꿈', { n: row.files })}</span>}
      {!workMode && steps !== null && (
        <span className="chat-steps" title={t('이 턴 동안 {name}{iga} 걸은 걸음', { name, iga: josa(name, '이가') })}>
          <PawIcon />{tSense('{n}걸음', 'chat', { n: steps })}
        </span>
      )}
      {copy && <CopyButton text={copy.text} label={t('답 복사')} cut={copy.cut} />}
    </div>
  )
}

export default TurnFoot
