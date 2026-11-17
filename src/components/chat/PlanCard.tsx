/**
 * A plan card (Phase 4): the plan Claude Code asks to approve — its first lines here, 더 보기 for the rest in
 * place (a box of its own scroll). Since 2026-11-17 a whole plan of the main thread is answered here too:
 * 승인 (the permission allowed) or 계속 계획하기 (denied: Claude plans on). Approving with edits accepted
 * automatically stays the terminal's (it would change the session's mode). A plan not shown whole, or a
 * sub-agent's: 터미널에서 답하기 only.
 */

import React, { useMemo, useState } from 'react'
import { t } from '../../i18n'
import { parseMarkdown } from '../../chat/markdown'
import { openFileFromChat, openUrlFromChat } from '../../chat/lensMode'
import { Markdown } from './Markdown'
import { AnswerButton, CardShell, StateLine, cardState, type CardProps } from './AnswerSurface'
import { useChatContext } from './context'

const FIRST = 6

export const PlanCard: React.FC<CardProps> = ({ card, local, shownAt, onAnswer, onTerminal }) => {
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
      {card.holdId && !cardState(card, local) ? (
        <div className="chat-card-acts">
          <AnswerButton className="chat-btn solid chat-card-btn" shownAt={shownAt} disabled={local.busy !== null} onAnswer={() => onAnswer('allow')}>{t('승인')}</AnswerButton>
          <AnswerButton className="chat-btn chat-card-btn" shownAt={shownAt} disabled={local.busy !== null} onAnswer={() => onAnswer('deny')}>{t('계속 계획하기')}</AnswerButton>
          <span className="chat-card-hint">{local.busy !== null ? t('보내는 중…') : local.retry ? t('보내지 못했어요 · 다시 눌러 주세요') : ''}</span>
          <button type="button" className="chat-link-btn chat-card-term" onClick={onTerminal} title={t('수정 자동 허용으로 승인하려면 터미널에서 골라 주세요')}>{t('터미널에서 답하기')}</button>
        </div>
      ) : (
        <StateLine state={cardState(card, local) ?? { text: '터미널에서 답해 주세요', terminal: true }} onTerminal={onTerminal} solid />
      )}
    </CardShell>
  )
}

export default PlanCard
