/**
 * A question card (Phase 4): Claude's one single-select question and its options as buttons, each
 * with its description under it — every word of it exact (review M4). Answerable only while it is
 * open and held for this chat (main releases it the moment this chat stops being the shown view); any
 * other question (several, multi-select, a sub-agent's) is shown read-only and answered in the
 * terminal. See AnswerSurface.tsx.
 */

import React from 'react'
import { t } from '../../i18n'
import { AnswerButton, CardShell, Exact, StateLine, cardState, type CardProps } from './AnswerSurface'

export const QuestionCard: React.FC<CardProps> = ({ card, local, shownAt, onAnswer, onTerminal }) => {
  const q = card.question
  const state = cardState(card, local)
  const busy = local.busy !== null
  const kind = q?.header ? <>{t('질문')} · <Exact text={q.header} /></> : t('질문')
  const options = q?.options ?? []
  return (
    <CardShell title={q?.text ? <Exact text={q.text} /> : t('질문')} label={q?.text || t('질문')} kind={kind} className="question">
      {state || !card.holdId ? (
        <>
          {options.length > 0 && (
            <ol className="chat-card-optlist">
              {options.map((o, i) => <li key={i}><Exact text={o.label} />{o.description && <span className="chat-card-optdesc"> — <Exact text={o.description} /></span>}</li>)}
            </ol>
          )}
          {state && <StateLine state={state} onTerminal={onTerminal} />}
        </>
      ) : (
        <>
          <div className="chat-card-opts">
            {options.map((o, i) => (
              <AnswerButton key={i} className="chat-btn chat-card-opt" shownAt={shownAt} disabled={busy} onAnswer={() => onAnswer('option', i)}>
                <span className="chat-card-optlabel"><Exact text={o.label} /></span>
                {o.description && <span className="chat-card-optdesc"><Exact text={o.description} /></span>}
              </AnswerButton>
            ))}
          </div>
          <div className="chat-card-acts">
            <span className="chat-card-hint">{busy ? t('보내는 중…') : local.retry ? t('보내지 못했어요 · 다시 눌러 주세요') : ''}</span>
            <button type="button" className="chat-link-btn chat-card-term" onClick={onTerminal}>{t('터미널에서 답하기')}</button>
          </div>
        </>
      )}
    </CardShell>
  )
}

export default QuestionCard
