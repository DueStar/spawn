/**
 * SystemPage (?system) — spawn's design system on one page (2026-11-17, the owner's ask: "모든 컴포넌트들을 정리하고
 * 시스템화 시켜서 한 페이지안에" — to look at and try every component, and to show it in the portfolio).
 *
 *   기초      colours, type (at every text size), radii and the icon set, read from the live tokens
 *   컨트롤    buttons, the switch, segmented toggles, the text-size control
 *   채팅      the chat's components with demo data, working: cards answer (into a fake terminal), menus open
 *
 * Every demo is the real component from src/, never a redrawing; the design QA page (?qa) keeps the moment-only
 * designs (notifications, session rows in each mood, the chat view whole).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import './styles/tokens.css'
import './styles/widget.css'
import './styles/widget-expanded.css'
import './styles/pokedex.css'
import './styles/chat.css'
import './styles/chat-game.css'
import './styles/system.css'
import * as AppIcons from './components/Icons'
import * as ChatIcons from './components/chat/ChatIcons'
import { ICON_SIZES, ICON_WEIGHT } from './components/Icons'
import { TextSizeControl } from './components/TextSizeControl'
import { setTextStep, TEXT_STEPS, textStepLabel, useTextStep } from './textSize'
import { UserMessage } from './components/chat/UserMessage'
import { ShellRow } from './components/chat/ShellRow'
import { ThinkingRow } from './components/chat/ThinkingRow'
import { QueueStrip } from './components/chat/QueueStrip'
import { QuestionCard } from './components/chat/QuestionCard'
import { PlanCard } from './components/chat/PlanCard'
import { DialogCard } from './components/chat/DialogCard'
import { DocToggle, MdDoc } from './components/chat/Markdown'
import { FileChips } from './components/chat/FileChips'
import { ControlRow } from './components/chat/ControlRow'
import { SlashMenu } from './components/chat/SlashMenu'
import { parseDialog, type Dialog } from './chat/dialog'
import { BUILTIN_COMMANDS, filterCommands } from './chat/slash'
import type { AskCard, LensStatus } from './chat/types'
import type { ChatWho } from './chat/lensMode'

const WHO: ChatWho = { picture: 'glyph', name: '에이전트' }
const noop = () => {}

// ---------------------------------------------------------------- the frame

const Spec: React.FC<{ name: string; file: string; note: string; children: React.ReactNode; wide?: boolean }> = ({ name, file, note, children, wide }) => (
  <section className={`sys-spec${wide ? ' wide' : ''}`}>
    <header>
      <b>{name}</b>
      <code>{file}</code>
    </header>
    <p className="sys-note">{note}</p>
    <div className="sys-demo">{children}</div>
  </section>
)

const SECTIONS = [['foundations', '기초'], ['controls', '컨트롤'], ['chat', '채팅']] as const

// ---------------------------------------------------------------- foundations

/** The custom properties on :root, as the stylesheets define them */
function rootTokens(): string[] {
  const names = new Set<string>()
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try { rules = sheet.cssRules } catch { continue }
    for (const r of Array.from(rules)) {
      if (!(r instanceof CSSStyleRule) || r.selectorText !== ':root') continue
      for (const p of Array.from(r.style)) if (p.startsWith('--')) names.add(p)
    }
  }
  return [...names]
}
const isColour = (v: string) => /^(#|rgb|hsl|color-mix)/.test(v.trim())

const Foundations: React.FC = () => {
  const step = useTextStep()
  const [tokens, setTokens] = useState<string[]>([])
  useEffect(() => { setTokens(rootTokens()) }, [])
  const css = getComputedStyle(document.documentElement)
  const colours = tokens.filter(t => isColour(css.getPropertyValue(t)))
  const type = tokens.filter(t => t.startsWith('--t-'))
  const radii = tokens.filter(t => t.startsWith('--r-'))
  const icons = useMemo(() => [...Object.entries(AppIcons), ...Object.entries(ChatIcons)]
    .filter(([k, v]) => /Icon$/.test(k) && typeof v === 'function') as [string, React.FC<{ size?: number }>][], [])
  return (
    <>
      <Spec name="색" file="src/styles/tokens.css" note="모든 색은 토큰으로만 써요. 노란색(--accent)은 보내기·선택·업데이트·켜진 스위치처럼 정해진 곳에만 써요." wide>
        <div className="sys-swatches">
          {colours.map(t => (
            <div key={t} className="sys-swatch">
              <i style={{ background: `var(${t})` }} />
              <span>{t}</span>
              <small>{css.getPropertyValue(t).trim()}</small>
            </div>
          ))}
        </div>
      </Spec>
      <Spec name="글자" file="src/styles/tokens.css · src/textSize.ts" note="크기는 토큰 9개, 글자 크기 단계(80~130%)마다 정수 px로 바뀌어요. 아래 단계를 눌러 보세요." wide>
        <div className="sys-steps">
          {TEXT_STEPS.map(s => <button key={s} className={`chat-btn${s === step ? ' solid' : ''}`} onClick={() => setTextStep(s)}>{textStepLabel(s)}</button>)}
        </div>
        <div className="sys-type">
          {type.map(t => (
            <div key={t} className="sys-type-row">
              <code>{t}</code>
              <small>{css.getPropertyValue(t).trim()}</small>
              <span style={{ fontSize: `var(${t})` }}>포켓몬과 함께 일해요 · Claude Code 123</span>
            </div>
          ))}
        </div>
      </Spec>
      <Spec name="모서리" file="src/styles/tokens.css" note="모서리는 이 단계만 써요 (0, 50%, 그리고 스위치·뱃지의 999px 예외).">
        <div className="sys-radii">{radii.map(t => <div key={t}><i style={{ borderRadius: `var(${t})` }} /><code>{t}</code><small>{css.getPropertyValue(t).trim()}</small></div>)}</div>
      </Spec>
      <Spec name="아이콘" file="src/components/Icons.tsx · src/components/chat/ChatIcons.tsx" note={`Phosphor, 굵기 하나(${ICON_WEIGHT}), 크기 ${ICON_SIZES.small} · ${ICON_SIZES.inline} · ${ICON_SIZES.button}. 창 버튼(최소화·최대화·복원)만 Windows 모양 그대로.`} wide>
        <div className="sys-icons">
          {icons.map(([name, C]) => (
            <div key={name} className="sys-icon" title={name}>
              <span><C size={12} /><C size={14} /><C size={16} /></span>
              <code>{name.replace(/Icon$/, '')}</code>
            </div>
          ))}
        </div>
      </Spec>
    </>
  )
}

// ---------------------------------------------------------------- controls

const Controls: React.FC = () => {
  const [on, setOn] = useState(true)
  const [raw, setRaw] = useState(false)
  return (
    <>
      <Spec name="버튼" file="src/styles/chat.css · widget.css" note="채팅 버튼(테두리), 강조 버튼(채움), 글자 버튼(밑줄 없는 링크), 업데이트 버튼(노랑 · 받는 중 · 실패).">
        <div className="sys-row">
          <button className="chat-btn">기본</button>
          <button className="chat-btn solid">강조</button>
          <button className="chat-link-btn">글자 버튼</button>
          <button className="w-update available" title="업데이트"><AppIcons.UpdateIcon size={14} /></button>
          <button className="w-update downloading" disabled title="받는 중"><AppIcons.UpdateIcon size={14} /></button>
          <button className="w-update available failed" title="실패"><AppIcons.UpdateIcon size={14} /></button>
        </div>
      </Spec>
      <Spec name="스위치" file="src/components/SettingsView.tsx" note="설정의 켜고 끄기. 켜지면 노랑.">
        <div className="sys-row">
          <button className={`set-switch${on ? ' on' : ''}`} role="switch" aria-checked={on} onClick={() => setOn(!on)}><i /></button>
          <span className="sys-small">{on ? '켜짐' : '꺼짐'}</span>
        </div>
      </Spec>
      <Spec name="두 갈래 전환" file="src/components/chat/Markdown.tsx DocToggle" note="문서 · 원문처럼 같은 것을 두 방식으로 볼 때.">
        <DocToggle raw={raw} onRaw={setRaw} />
      </Spec>
      <Spec name="글자 크기" file="src/components/TextSizeControl.tsx" note="− 100% +. 10%씩, 휠로도. 가운데를 누르면 단계 목록.">
        <div className="w-term-tabs sys-bar"><TextSizeControl /></div>
      </Spec>
    </>
  )
}

// ---------------------------------------------------------------- chat

const MODEL_SCREEN = (marked: number) => [
  '   Switch model?',
  '   This will clear the prompt cache for this conversation.',
  '',
  `   ${marked === 0 ? '>' : ' '} 1. Yes, switch to Sonnet 5.5`,
  `   ${marked === 1 ? '>' : ' '} 2. No, keep Opus 5.5`,
  '',
  '   Enter to confirm · Esc to cancel',
].join('\n')

/** A pretend terminal behind the dialog card: ↑ / ↓ move the mark, Enter or Esc close it */
const DialogDemo: React.FC = () => {
  const marked = useRef(0)
  const [screen, setScreen] = useState<string | null>(MODEL_SCREEN(0))
  const [said, setSaid] = useState('')
  const dialog: Dialog | null = parseDialog(screen)
  const key = async ({ key: k }: { key: string }) => {
    if (k === 'down') marked.current = Math.min(1, marked.current + 1)
    if (k === 'up') marked.current = Math.max(0, marked.current - 1)
    if (k === 'enter' || k === 'esc') { setScreen(null); setSaid(k === 'esc' ? '취소했어요' : marked.current === 0 ? 'Sonnet으로 바꿨어요' : 'Opus를 그대로 써요'); return { ok: true } }
    setScreen(MODEL_SCREEN(marked.current))
    return { ok: true }
  }
  if (!dialog) return <div className="sys-row"><span className="sys-small">{said}</span><button className="chat-btn" onClick={() => { marked.current = 0; setScreen(MODEL_SCREEN(0)) }}>다시 띄우기</button></div>
  return <DialogCard id="demo" dialog={dialog} dialogKey={key} read={() => MODEL_SCREEN(marked.current)} />
}

/** /remote-control's panel as 2.1.328 draws it (reconstructed: tests/fixtures/chat/screens/reconstructed-rc-panel.txt) */
const RC_SCREEN = [
  '────────────────────────────────────────',
  ' Remote Control',
  '',
  ' This session is available in the Claude mobile app and at https://claude.ai/code/session_01AbCdEfGh',
  '',
  '   Disconnect this session',
  '   Show QR code',
  '     Scan with your phone to open this session',
  ' ❯ Continue',
].join('\n')

const card = (extra: Partial<AskCard>): AskCard => ({
  key: 'h', holdId: 'h', kind: 'question', toolId: null, agent: false, tool: 'AskUserQuestion', input: {}, always: null, state: 'open', since: Date.now(), ...extra,
})
const local = { busy: null, refused: false }

const Chat: React.FC = () => {
  const [answered, setAnswered] = useState('')
  const [slashSel, setSlashSel] = useState(0)
  const answer = (c: string, o?: number, p?: number[][]) => setAnswered(`${c} ${o ?? ''} ${p ? JSON.stringify(p) : ''}`)
  const queue: LensStatus = { state: 'working', since: Date.now(), label: null, banner: null, note: null, version: null, hasOlder: false, empty: false, queued: [{ text: '끝나면 테스트도 돌려 주세요', truncated: false }, { text: '그리고 README 정리', truncated: false }, { text: '마지막으로 커밋', truncated: false }], queuedCount: 4 } as LensStatus
  return (
    <>
      <Spec name="보낸 메시지" file="src/components/chat/UserMessage.tsx" note="@로 고른 파일은 말풍선 위 뱃지로, 글은 말풍선에.">
        <UserMessage item={{ id: 'u', order: 1, at: null, kind: 'user', text: '@README.md @src/app.ts 이 두 파일 요약해줘', images: 0 }} time="오후 3:12" />
      </Spec>
      <Spec name="입력란 파일 뱃지" file="src/components/chat/FileChips.tsx" note="입력란 위에 모이고 ×로 빠져요. 보낼 때 @경로로 붙어요.">
        <FileChips files={['README.md', 'src/components/chat/Composer.tsx']} onRemove={noop} />
      </Spec>
      <Spec name="셸 블록" file="src/components/chat/ShellRow.tsx" note="!로 실행한 명령과 결과. 12줄이 넘으면 접혀요.">
        <ShellRow item={{ id: 's', order: 2, at: null, kind: 'shell', command: 'git status', state: 'done', stdout: 'On branch main\nYour branch is up to date with origin/main.\n\nnothing to commit, working tree clean' }} time="오후 3:13" />
      </Spec>
      <Spec name="진행 설명" file="src/components/chat/ThinkingRow.tsx" note="Claude가 일하며 쓰는 말 (thinkingDisplay updates). 일반 글처럼.">
        <ThinkingRow item={{ id: 't', order: 3, at: null, kind: 'thinking', text: '판매 페이지를 캡처했어요. 이제 **상세 이미지**를 내려받을게요.', update: true }} />
      </Spec>
      <Spec name="대기 중인 메시지" file="src/components/chat/QueueStrip.tsx" note="눌러서 전체 목록을 펼쳐요. 기록이 주는 글은 3개까지.">
        <div className="sys-composer"><QueueStrip status={queue} /><div className="chat-cbox sys-box">…</div></div>
      </Spec>
      <Spec name="질문 카드 · 하나" file="src/components/chat/QuestionCard.tsx" note="보기를 누르면 바로 답해요.">
        <QuestionCard card={card({ question: { text: '어떤 형식으로 정리할까요?', header: '형식', options: [{ label: 'JSON', description: '스크립트용' }, { label: 'Markdown', description: 'README용' }] } })} who={WHO} local={local} shownAt={() => 0} onAnswer={answer} onTerminal={noop} />
      </Spec>
      <Spec name="질문 카드 · 여러 개" file="src/components/chat/QuestionCard.tsx" note="질문마다 고르고 보내기. 여러 개 고르는 질문은 네모 표시.">
        <QuestionCard card={card({ question: { text: '어디에 만들까요?', options: [{ label: '조직' }, { label: '개인' }] }, questions: [{ text: '어디에 만들까요?', header: '위치', options: [{ label: '조직' }, { label: '개인' }] }, { text: '무엇을 함께 할까요?', header: '범위', multiSelect: true, options: [{ label: '테스트' }, { label: '문서' }, { label: '배포' }] }] })} who={WHO} local={local} shownAt={() => 0} onAnswer={answer} onTerminal={noop} />
      </Spec>
      <Spec name="계획 카드" file="src/components/chat/PlanCard.tsx" note="승인 · 계속 계획하기. 계획이 길면 더 보기.">
        <PlanCard card={card({ kind: 'plan', tool: 'ExitPlanMode', input: { plan: '# 계획: 파일 이름 바꾸기\n\n1. `git mv notes.txt notes.md`\n2. README는 그대로\n3. git status로 확인' } })} who={WHO} local={local} shownAt={() => 0} onAnswer={answer} onTerminal={noop} />
      </Spec>
      <Spec name="선택 창 카드" file="src/components/chat/DialogCard.tsx · src/chat/dialog.ts" note="훅이 못 잡은 터미널 선택 창을 화면에서 읽어 카드로. 여기선 가짜 터미널에 답해요.">
        <DialogDemo />
      </Spec>
      <Spec name="패널 카드" file="src/components/chat/DialogCard.tsx · src/chat/dialog.ts" note="번호 없는 줄 목록(/rc 같은 패널)도 카드로. 링크는 통째로 보여 주고 복사돼요.">
        <DialogCard id="sys-rc" dialog={parseDialog(RC_SCREEN)!} dialogKey={async () => ({ ok: true })} read={() => RC_SCREEN} />
      </Spec>
      <Spec name="명령 메뉴" file="src/components/chat/SlashMenu.tsx · src/chat/slash.ts" note="입력란에 /를 치면 떠요. ↑↓로 고르고 Enter·Tab이면 /이름 을 채워요(보내지는 않아요).">
        <div className="sys-composer sys-slash">
          <SlashMenu listId="sys-slash" commands={filterCommands(BUILTIN_COMMANDS, 're')} sel={slashSel} onPick={i => setAnswered(`/${filterCommands(BUILTIN_COMMANDS, 're')[i].name} `)} onHover={setSlashSel} />
          <div className="chat-cbox sys-box">/re</div>
        </div>
      </Spec>
      <Spec name="문서 카드" file="src/components/chat/Markdown.tsx MdDoc" note="마크다운 블록과 새 .md 파일. 문서 · 원문." wide>
        <MdDoc title="markdown" text={'# 1.7.0 노트\n\n## 채팅\n- 선택 창을 카드로\n- 모델·모드 메뉴\n\n| 항목 | 상태 |\n|---|---|\n| 다중 선택 | 확인 대기 |\n| plan 승인 | 확인 대기 |'} onLink={noop} onPath={noop} />
      </Spec>
      <Spec name="입력란 아래 줄" file="src/components/chat/ControlRow.tsx" note="모델과 권한 모드는 눌러서 바꿔요. HP와 사용량은 보기만." wide>
        <div className="sys-composer"><ControlRow control={{ model: 'Opus 5.5', context: { left: 62, tip: '남은 컨텍스트 62%', label: 'HP' }, usage: { fiveHour: 23, weekly: 41 } }} mode="acceptEdits"
          actions={{ onModel: m => setAnswered(`model ${m}`), onMode: m => setAnswered(`mode ${m}`), modelWhy: null, modeWhy: null, unreachable: new Set(['bypassPermissions']), busy: false }} /></div>
      </Spec>
      {answered && <p className="sys-said" role="status">카드가 보낸 것: {answered}</p>}
    </>
  )
}

export default function SystemPage() {
  const [at, setAt] = useState<(typeof SECTIONS)[number][0]>('foundations')
  return (
    <div className="sys">
      <nav className="sys-nav">
        <b>spawn 디자인 시스템</b>
        {SECTIONS.map(([k, label]) => <button key={k} className={at === k ? 'on' : ''} onClick={() => setAt(k)}>{label}</button>)}
        <a href="?qa">순간 화면 (QA) →</a>
      </nav>
      <main className="sys-main chat" key={at}>
        {at === 'foundations' && <Foundations />}
        {at === 'controls' && <Controls />}
        {at === 'chat' && <Chat />}
      </main>
    </div>
  )
}
