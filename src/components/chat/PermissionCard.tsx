/**
 * A permission card (Phase 4): what Claude Code asks to do, whole — the command (scrollable, never
 * cut, hidden characters shown) with the folder it runs in and, each on a line of its own, running
 * outside the sandbox (the amber "needs you" mark), in the background, a time limit; the file (its
 * whole path, wrapped) and its change (every line, wrapped), a Write over a file that is there called
 * an overwrite; the URL and what is asked of the page; or any other tool's whole input — then 허용
 * (the ink button), 항상 허용 (only with a rule of this tool the hook itself suggested, for this
 * session; never for an edit), 거부 (a hairline button: Claude is told and may try another way), and
 * 터미널에서 보기. 허용 and 항상 허용 wait until every box that scrolls has been seen to its end
 * (review I1). See AnswerSurface.tsx for how an answer is made and said.
 */

import React, { useCallback, useRef, useState } from 'react'
import { t } from '../../i18n'
import type { AskCard, DiffLine } from '../../chat/types'
import { AnswerButton, CardShell, Exact, StateLine, WithExact, cardState, nameVars, useSeenToEnd, type CardProps } from './AnswerSurface'

/** The card's title by tool ({tool}: the tool's own name) */
export function permissionTitle(card: AskCard): string {
  switch (card.tool) {
    case 'Bash': case 'PowerShell': return '이 명령을 실행해도 될까요?'
    case 'Edit': return '이 파일을 고쳐도 될까요?'
    case 'Write': return card.overwrite ? '이 파일을 덮어써도 될까요?' : '새 파일을 만들어도 될까요?'
    case 'WebFetch': return '이 페이지를 읽어도 될까요?'
    default: return '{tool} 도구를 써도 될까요?'
  }
}

type Seen = (name: string, seen: boolean) => void

/** A box of exact text with its own scroll; says so (and holds 허용 back) until it has been seen to its end */
const ExactBox: React.FC<{ id: string; name: string; text: string; prompt?: string; className?: string; onSeen: Seen }> = ({ id, name, text, prompt, className = '', onSeen }) => {
  const box = useRef<HTMLDivElement>(null)
  const { more, unseen } = useSeenToEnd(box, (s) => onSeen(name, s))
  return (
    <>
      {/* (a box that scrolls takes the focus, so its arrows scroll it) */}
      <div ref={box} id={id} className={`chat-card-cmd${className ? ` ${className}` : ''}`} tabIndex={more ? 0 : undefined}>
        <div className="chat-card-in">{prompt && <span className="chat-card-pr" aria-hidden="true">{prompt}</span>}<Exact text={text} /></div>
      </div>
      {unseen && <div className="chat-card-sub">{t('길어요 · 끝까지 내려서 확인해 주세요')}</div>}
    </>
  )
}

/** What an edit or a file write would change: the whole path, then every line (wrapped), in a box of its own scroll */
const CardDiff: React.FC<{ id: string; card: AskCard; onSeen: Seen }> = ({ id, card, onSeen }) => {
  const diff = card.diff!
  const lines: DiffLine[] = diff.hunks.flatMap(h => h.lines)
  const box = useRef<HTMLDivElement>(null)
  const { more, unseen } = useSeenToEnd(box, (s) => onSeen('diff', s))
  return (
    <>
      <div className="chat-diff chat-card-diff" id={id}>
        <div className="chat-diff-head">
          {diff.kind === 'create' && <span className="chat-diff-kind">{t('새 파일')}</span>}
          <span className="chat-diff-file chat-card-file"><Exact text={card.input.file ?? diff.file} /></span>
          {/* (an overwrite: what goes is the whole file, not counted here) */}
          <span className="chat-counts" aria-label={card.overwrite ? `+${diff.added}` : `+${diff.added} −${diff.removed}`}>
            <span className={diff.added ? 'a' : 'z'}>+{diff.added}</span>
            {!card.overwrite && <span className={diff.removed ? 'd' : 'z'}>−{diff.removed}</span>}
          </span>
        </div>
        {lines.length > 0 && (
          <div ref={box} className="chat-diff-lines chat-card-lines" tabIndex={more ? 0 : undefined}>
            <div className="chat-card-in">
              {lines.map((l, i) => (
                <div key={i} className={`chat-dl nonum${l.t === '+' ? ' add' : l.t === '-' ? ' del' : ''}`}>
                  <span className="sg">{l.t === ' ' ? '' : l.t === '-' ? '−' : '+'}</span>
                  <span className="tx"><Exact text={l.text} ws={l.t !== ' '} /></span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {unseen && <div className="chat-card-sub">{t('길어요 · 끝까지 내려서 확인해 주세요')}</div>}
    </>
  )
}

/** What 항상 허용 adds, said under the buttons (the rule exactly; for this session only) */
const AlwaysRule: React.FC<{ id: string; rule: string }> = ({ id, rule }) => (
  <div id={id} className="chat-card-rule"><WithExact k="항상 허용하면 이 세션 동안 같은 요청은 묻지 않아요: {rule}" name="rule" value={rule} /></div>
)

/** A line of its own under what is asked: a fact about the call (exact where it holds the request's own words) */
const Fact: React.FC<{ warn?: boolean; children: React.ReactNode }> = ({ warn = false, children }) => (
  <div className={`chat-card-fact${warn ? ' warn' : ''}`}>{warn && <i className="chat-dot amber" aria-hidden="true" />}<span>{children}</span></div>
)

export const PermissionCard: React.FC<CardProps> = ({ card, who, local, shownAt, onAnswer, onTerminal }) => {
  const key = permissionTitle(card)
  const label = t(key, { tool: card.tool })
  const title = key.includes('{tool}') ? <WithExact k={key} name="tool" value={card.tool} /> : label
  const state = cardState(card, local)
  const busy = local.busy !== null
  const { input } = card
  // every box that scrolls, seen to its end (a box that fits: at once); 허용 waits for all of them
  const [seen, setSeen] = useState<Record<string, boolean>>({})
  const onSeen = useCallback<Seen>((name, s) => setSeen(cur => (cur[name] === s ? cur : { ...cur, [name]: s })), [])
  const boxes = [
    input.command !== undefined && 'command', input.url !== undefined && 'url',
    card.diff ? (card.diff.hunks.length ? 'diff' : false) : input.file !== undefined && 'file', card.args !== undefined && 'args',
  ].filter((b): b is string => !!b)
  const allSeen = boxes.every(b => seen[b] === true)
  const what = `${card.key}-what`
  const whatIds = boxes.map(b => `${what}-${b}`).concat(card.diff && !card.diff.hunks.length ? [`${what}-diff`] : [])
  const hintId = `${card.key}-hint`
  const gate = !allSeen ? t('끝까지 내려서 확인하면 허용할 수 있어요') : undefined
  // (허용 is described by what it approves, review M9, and by why it waits)
  const allowDescribedBy = [...whatIds, ...(gate ? [hintId] : [])].join(' ') || undefined
  const timeoutS = card.timeoutMs ? Math.round(card.timeoutMs / 100) / 10 : 0
  return (
    <CardShell title={title} label={label} kind={t('권한 요청')}>
      {input.command !== undefined && <ExactBox id={`${what}-command`} name="command" text={input.command} prompt="$ " onSeen={onSeen} />}
      {input.url !== undefined && <ExactBox id={`${what}-url`} name="url" text={input.url} onSeen={onSeen} />}
      {card.diff ? <CardDiff id={`${what}-diff`} card={card} onSeen={onSeen} /> : input.file !== undefined && <ExactBox id={`${what}-file`} name="file" text={input.file} onSeen={onSeen} />}
      {card.args !== undefined && <ExactBox id={`${what}-args`} name="args" text={card.args} className="args" onSeen={onSeen} />}
      {card.sandboxOff && <Fact warn>{t('격리 환경(sandbox) 밖에서 실행해요')}</Fact>}
      {card.background && <Fact>{t('백그라운드에서 실행해요')}</Fact>}
      {timeoutS > 0 && <Fact>{t('시간 제한 {n}초', { n: timeoutS })}</Fact>}
      {card.overwrite && <Fact>{t('기존 내용을 모두 바꿔요')}</Fact>}
      {card.replaceAll && <Fact>{t('같은 글을 모두 바꿔요')}</Fact>}
      {card.diff?.eol && <Fact>{t(card.diff.eol === 'added' ? '바뀌는 부분 끝에 줄바꿈이 생겨요' : '바뀌는 부분 끝의 줄바꿈이 없어져요')}</Fact>}
      {card.cwd !== undefined && <Fact><WithExact k="실행 폴더: {path}" name="path" value={card.cwd} /></Fact>}
      {card.fetchPrompt !== undefined && <Fact><WithExact k="페이지에 물을 것: {text}" name="text" value={card.fetchPrompt} /></Fact>}
      {input.description !== undefined && <Fact><WithExact k="{name}의 설명: {text}" name="text" value={input.description} vars={{ name: who.name }} /></Fact>}
      {card.agent && <Fact>{t('보조 에이전트의 요청이에요')}</Fact>}
      {state ? <StateLine state={state} onTerminal={onTerminal} /> : (
        <div className="chat-card-acts">
          <AnswerButton className="chat-btn solid chat-card-btn" shownAt={shownAt} disabled={busy || !allSeen} title={gate} onAnswer={() => onAnswer('allow')} describedBy={allowDescribedBy}>{t('허용')}</AnswerButton>
          {card.always && (
            <AnswerButton className="chat-btn chat-card-btn" shownAt={shownAt} disabled={busy || !allSeen} onAnswer={() => onAnswer('always')}
              title={gate ?? t('이 세션 동안 같은 요청은 묻지 않아요: {rule}', { rule: card.always.rule })} describedBy={[`${card.key}-rule`, ...(gate ? [hintId] : [])].join(' ')}>{t('항상 허용')}</AnswerButton>
          )}
          <AnswerButton className="chat-btn chat-card-btn" shownAt={shownAt} disabled={busy} onAnswer={() => onAnswer('deny')}>{t('거부')}</AnswerButton>
          <span className="chat-card-hint" id={hintId}>
            {busy ? t('보내는 중…') : gate ?? (local.retry ? t('보내지 못했어요 · 다시 눌러 주세요') : t('거부하면 {name}{iga} 다른 방법을 찾을 수 있어요', nameVars(who.name)))}
          </span>
          <button type="button" className="chat-link-btn chat-card-term" onClick={onTerminal}>{t('터미널에서 보기')}</button>
        </div>
      )}
      {card.always && !state && <AlwaysRule id={`${card.key}-rule`} rule={card.always.rule} />}
    </CardShell>
  )
}

export default PermissionCard
