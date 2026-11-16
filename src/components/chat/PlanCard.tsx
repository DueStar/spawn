/**
 * A plan card (Phase 4): the plan Claude Code asks to approve, read-only. Plan approval stays the
 * terminal's (answering it from a hook is not verified): its first lines here, 더 보기 for the rest
 * in place (a box of its own scroll), and 터미널에서 답하기. No answer button.
 */

import React, { useMemo, useState } from 'react'
import { t } from '../../i18n'
import { parseMarkdown } from '../../chat/markdown'
import { openFileFromChat, openUrlFromChat } from '../../chat/lensMode'
import { Markdown } from './Markdown'
import { CardShell, StateLine, type CardProps } from './AnswerSurface'
import { useChatContext } from './context'

const FIRST = 6

export const PlanCard: React.FC<CardProps> = ({ card, onTerminal }) => {
  const { id } = useChatContext()
  const [all, setAll] = useState(false)
  const plan = card.input.plan ?? ''
  const lines = plan.split('\n')
  const longer = lines.length > FIRST
  const shown = all || !longer ? plan : lines.slice(0, FIRST).join('\n')
  const blocks = useMemo(() => parseMarkdown(shown), [shown])
  return (
    <CardShell title={t('계획을 확인해 주세요')} label={t('계획을 확인해 주세요')} kind={t('계획')} className="plan">
      <div className={`chat-prose chat-card-plan${all ? ' all' : ''}`} tabIndex={all ? 0 : undefined}>
        <Markdown blocks={blocks} onLink={openUrlFromChat} onPath={(file, line, col) => openFileFromChat(id, file, line, col)} />
      </div>
      {longer && (
        <button type="button" className="chat-link-btn chat-card-more" aria-expanded={all} onClick={() => setAll(!all)}>{all ? t('접기') : t('더 보기')}</button>
      )}
      <StateLine state={{ text: '터미널에서 답해 주세요', terminal: true }} onTerminal={onTerminal} solid />
    </CardShell>
  )
}

export default PlanCard
