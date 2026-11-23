/**
 * A question card: Claude's question and its options as buttons, each with its description under
 * it — every word of it exact. One single-select question: a click on an option answers it.
 * Several questions, or a multi-select one: each question with its
 * options to pick (one, or any number for a multi-select), then 보내기 once every question has a pick.
 * Answerable only while it is open and held for this chat (main releases it the moment this chat stops being
 * the shown view); a sub-agent's question is shown read-only and answered in the terminal. See AnswerSurface.tsx.
 *
 * 직접 입력 (free text): Claude Code's dialog always ends a question's options with its "Other" row, where the user
 * types their own answer. Here it is the last option of each question, with a field: one question's own words are its
 * answer (alone, in a single-select; after the picks, in a multi-select), sent as the terminal's dialog would send them.
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

/**
 * A question's own words, its last option: "직접 입력" and a field, a <label> (a press on it puts the caret in the
 * field: the browser's own, never a focus move of the card's). Enter sends (never mid-composition); Esc clears it.
 */
const WordsRow: React.FC<{ value: string; disabled: boolean; on: boolean; multi?: boolean; pick?: boolean; onChange(v: string): void; onEnter?(): void; children?: React.ReactNode }> = ({ value, disabled, on, multi, pick, onChange, onEnter, children }) => (
  <div className={`chat-card-words chat-card-other${on ? ' on' : ''}`}>
    <label className="chat-card-otherlabel">
      {pick && <span className={`chat-card-mark${multi ? ' multi' : ''}`} aria-hidden="true" />}
      <span>{t('직접 입력')}</span>
      <input className="chat-card-field" value={value} disabled={disabled} placeholder={t('답을 직접 적어 주세요')} aria-label={t('직접 입력한 답')} maxLength={2000}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape' && value) { e.preventDefault(); e.stopPropagation(); onChange(''); return }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); e.stopPropagation(); onEnter?.() }
        }} />
    </label>
    {children}
  </div>
)

export const QuestionCard: React.FC<CardProps> = ({ card, local, shownAt, onAnswer, onTerminal }) => {
  const q = card.question
  const qs: Question[] = card.questions ?? (q ? [q] : [])
  const several = !!card.questions
  const state = cardState(card, local)
  const busy = local.busy !== null
  const [picks, setPicks] = useState<number[][]>(() => qs.map(() => []))
  // each question's own words (its 직접 입력): '' while none are written
  const [words, setWords] = useState<string[]>(() => qs.map(() => ''))
  const head = several && qs.length > 1 ? null : q
  const kind = head?.header ? <>{t('질문')} · <Exact text={head.header} /></> : qs.length > 1 ? t('질문 {n}개', { n: qs.length }) : t('질문')
  const title = several && qs.length > 1 ? t('{n}가지를 골라 주세요', { n: qs.length }) : q?.text ? <Exact text={q.text} /> : t('질문')
  const label = several && qs.length > 1 ? t('{n}가지를 골라 주세요', { n: qs.length }) : q?.text || t('질문')
  const toggle = (qi: number, oi: number) => {
    setPicks(cur => cur.map((p, i) => {
      if (i !== qi) return p
      if (!qs[qi].multiSelect) return [oi]
      return p.includes(oi) ? p.filter(x => x !== oi) : [...p, oi]
    }))
    // (a single-select's option and its own words are one answer or the other)
    if (!qs[qi].multiSelect) setWords(cur => cur.map((w, i) => (i === qi ? '' : w)))
  }
  const setWord = (qi: number, v: string) => {
    setWords(cur => cur.map((w, i) => (i === qi ? v : w)))
    if (v.trim() && !qs[qi].multiSelect) setPicks(cur => cur.map((p, i) => (i === qi ? [] : p)))
  }
  const own = (qi: number) => (words[qi]?.trim() ? words[qi] : null)
  const ready = picks.length === qs.length && picks.every((p, i) => p.length > 0 || own(i) !== null)
  const other = () => qs.map((_, i) => own(i))
  const sendAll = () => { if (ready && !busy) onAnswer('options', undefined, picks, other()) }
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
              {o.preview && <pre className="chat-card-optpre">{o.preview}</pre>}
            </AnswerButton>
          ))}
          <WordsRow value={words[0]} disabled={busy} on={own(0) !== null} onChange={v => setWord(0, v)} onEnter={sendAll}>
            <AnswerButton className="chat-btn solid chat-card-btn" shownAt={shownAt} disabled={busy || !ready} onAnswer={sendAll}>{t('보내기')}</AnswerButton>
          </WordsRow>
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
                  {o.preview && <pre className="chat-card-optpre">{o.preview}</pre>}
                </button>
              )
            })}
            <WordsRow value={words[qi] ?? ''} disabled={busy} on={own(qi) !== null} pick multi={!!x.multiSelect} onChange={v => setWord(qi, v)} onEnter={sendAll} />
          </div>
        </div>
      ))}
      <div className="chat-card-acts">
        {several && (
          <AnswerButton className="chat-btn solid chat-card-btn" shownAt={shownAt} disabled={busy || !ready} onAnswer={sendAll}>
            {t('보내기')}
          </AnswerButton>
        )}
        <span className="chat-card-hint">{hint || (several && !ready ? t('모든 질문에 골라 주거나 직접 적어 주세요') : '')}</span>
        <button type="button" className="chat-link-btn chat-card-term" onClick={onTerminal}>{t('터미널에서 답하기')}</button>
      </div>
    </CardShell>
  )
}

export default QuestionCard
