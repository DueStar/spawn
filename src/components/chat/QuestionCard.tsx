/**
 * A question card (Phase 4): Claude's question and its options as buttons, each with its description under
 * it — every word of it exact (review M4). One single-select question: a click on an option answers it.
 * Several questions, or a multi-select one (2026-11-17; the terminal's until then): each question with its
 * options to pick (one, or any number for a multi-select), then 보내기 once every question has a pick.
 * Answerable only while it is open and held for this chat (main releases it the moment this chat stops being
 * the shown view); a sub-agent's question is shown read-only and answered in the terminal. See AnswerSurface.tsx.
 */

import React, { useState } from 'react'
import { t } from '../../i18n'
import { AnswerButton, CardShell, Exact, StateLine, cardState, type CardProps } from './AnswerSurface'

type Question = NonNullable<CardProps['card']['question']> & { multiSelect?: true }

const OptionList: React.FC<{ q: Question }> = ({ q }) => (
  <ol className="chat-card-optlist">
    {q.options.map((o, i) => <li key={i}><Exact text={o.label} />{o.description && <span className="chat-card-optdesc"> — <Exact text={o.description} /></span>}</li>)}
  </ol>
)

export const QuestionCard: React.FC<CardProps> = ({ card, local, shownAt, onAnswer, onTerminal }) => {
  const q = card.question
  const qs: Question[] = card.questions ?? (q ? [q] : [])
  const several = !!card.questions
  const state = cardState(card, local)
  const busy = local.busy !== null
  const [picks, setPicks] = useState<number[][]>(() => qs.map(() => []))
  const head = several && qs.length > 1 ? null : q
  const kind = head?.header ? <>{t('질문')} · <Exact text={head.header} /></> : qs.length > 1 ? t('질문 {n}개', { n: qs.length }) : t('질문')
  const title = several && qs.length > 1 ? t('{n}가지를 골라 주세요', { n: qs.length }) : q?.text ? <Exact text={q.text} /> : t('질문')
  const label = several && qs.length > 1 ? t('{n}가지를 골라 주세요', { n: qs.length }) : q?.text || t('질문')
  const toggle = (qi: number, oi: number) => setPicks(cur => cur.map((p, i) => {
    if (i !== qi) return p
    if (!qs[qi].multiSelect) return [oi]
    return p.includes(oi) ? p.filter(x => x !== oi) : [...p, oi]
  }))
  const ready = picks.length === qs.length && picks.every(p => p.length > 0)
  const hint = busy ? t('보내는 중…') : local.retry ? t('보내지 못했어요 · 다시 눌러 주세요') : ''

  if (state || !card.holdId) {
    return (
      <CardShell title={title} label={label} kind={kind} className="question">
        {qs.map((x, i) => (
          <div key={i} className="chat-card-q">
            {qs.length > 1 && <p className="chat-card-qtext">{x.header && <b><Exact text={x.header} /> · </b>}<Exact text={x.text} /></p>}
            {x.options.length > 0 && <OptionList q={x} />}
          </div>
        ))}
        {state && <StateLine state={state} onTerminal={onTerminal} />}
      </CardShell>
    )
  }

  return (
    <CardShell title={title} label={label} kind={kind} className="question">
      {!several ? (
        <div className="chat-card-opts">
          {qs[0].options.map((o, i) => (
            <AnswerButton key={i} className="chat-btn chat-card-opt" shownAt={shownAt} disabled={busy} onAnswer={() => onAnswer('option', i)}>
              <span className="chat-card-optlabel"><Exact text={o.label} /></span>
              {o.description && <span className="chat-card-optdesc"><Exact text={o.description} /></span>}
            </AnswerButton>
          ))}
        </div>
      ) : qs.map((x, qi) => (
        <div key={qi} className="chat-card-q" role="group" aria-label={x.text}>
          {(qs.length > 1 || x.multiSelect) && (
            <p className="chat-card-qtext">
              {x.header && <b><Exact text={x.header} /> · </b>}<Exact text={x.text} />
              {x.multiSelect && <span className="chat-card-qmulti"> · {t('여러 개 고를 수 있어요')}</span>}
            </p>
          )}
          <div className="chat-card-opts">
            {x.options.map((o, oi) => {
              const on = picks[qi]?.includes(oi) ?? false
              return (
                <button key={oi} type="button" className={`chat-btn chat-card-opt pick${on ? ' on' : ''}${x.multiSelect ? ' multi' : ''}`}
                  aria-pressed={on} disabled={busy} onClick={() => toggle(qi, oi)}>
                  <span className="chat-card-optlabel"><span className="chat-card-mark" aria-hidden="true" /><Exact text={o.label} /></span>
                  {o.description && <span className="chat-card-optdesc"><Exact text={o.description} /></span>}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      <div className="chat-card-acts">
        {several && (
          <AnswerButton className="chat-btn solid chat-card-btn" shownAt={shownAt} disabled={busy || !ready} onAnswer={() => onAnswer('options', undefined, picks)}>
            {t('보내기')}
          </AnswerButton>
        )}
        <span className="chat-card-hint">{hint || (several && !ready ? t('모든 질문에 하나 이상 골라 주세요') : '')}</span>
        <button type="button" className="chat-link-btn chat-card-term" onClick={onTerminal}>{t('터미널에서 답하기')}</button>
      </div>
    </CardShell>
  )
}

export default QuestionCard
