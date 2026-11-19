/**
 * A thinking block in the chat view (shown from 생각 포함): a left hairline, `생각 · {time}`
 * quiet above, then what was thought in the quiet grey. Claude Code 2.1.32x writes the thinking itself empty,
 * and a redacted block holds none: the row then says it is not in the record, never a guess.
 * A later Claude Code that writes the text gets it shown, as prose.
 */

import React, { useMemo } from 'react'
import { t } from '../../i18n'
import { parseMarkdown } from '../../chat/markdown'
import { formatDuration } from '../../chat/toolLabel'
import type { ThinkingItem } from '../../chat/types'
import { useChatContext } from './context'
import { Markdown } from './Markdown'
import { FullButton } from './FullView'

/** The time thought, to the nearest second (under a second reads 1초, never 0초) */
function thoughtFor(ms: number): string {
  const d = formatDuration(Math.max(1, Math.round(ms / 1000)) * 1000)
  return t(d.text, d.vars)
}

export const ThinkingRow: React.FC<{ item: ThinkingItem }> = ({ item }) => {
  const { onLink, onPath } = useChatContext()
  const text = item.redacted ? '' : item.text
  const blocks = useMemo(() => (text.trim() ? parseMarkdown(text) : null), [text])
  // a progress note (thinkingDisplay "updates"): what the terminal shows as Claude's words, so the chat's prose
  if (item.update && blocks) return <div className="chat-prose chat-update"><Markdown blocks={blocks} onLink={onLink} onPath={onPath} /></div>
  return (
    <div className="chat-think">
      <b className="chat-think-head">{item.durationMs !== undefined ? t('생각 · {time}', { time: thoughtFor(item.durationMs) }) : t('생각')}</b>
      {blocks
        ? <div className="chat-prose chat-think-text"><Markdown blocks={blocks} onLink={onLink} onPath={onPath} /></div>
        : <p className="chat-think-none">{t('생각한 내용은 기록에 남지 않았어요')}</p>}
      {blocks && item.truncated && <p className="chat-cut">{t('글이 길어서 앞부분만 보여요')} <FullButton itemId={item.id} title={t('생각 전체')} /></p>}
    </div>
  )
}

export default ThinkingRow
