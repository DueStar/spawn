/**
 * The QA page's 채팅 section (src/QaPage.tsx): the chat view (src/components/ChatView.tsx)
 * with a fixed conversation — no bridge, no session — in this shape: a question, reads and searches folded, an answer with a table,
 * a list, code and a link, an edit with its diff, a failed command, a call waiting on the
 * terminal. Then the read-failed banner over it, and a new session's empty state.
 */

import React from 'react'
import ChatView from './components/ChatView'
import { Composer, type ComposerControl, type Note } from './components/chat/Composer'
import { AnswerSurface } from './components/chat/AnswerSurface'
import { chatWho } from './chat/lensMode'
import type { ChatState } from './chat/store'
import type { AskCard, ChatItem, LensStatus } from './chat/types'
import { LIVE_BASE, PENDING_BASE } from './chat/types'
import type { TerminalInfo } from './desktop'
import { useWorkMode } from './settingsStore'
import { iconUrl, spriteUrl } from './theme'

const T0 = Date.now() - 4 * 60_000
const at = (s: number) => T0 + s * 1000

const ANSWER = [
  '## 원인',
  '',
  '로그인이 끝나면 `next` 값으로 돌려보내는데, 미들웨어가 이 값을 `new URL(next)`로 바로 읽어요. 값이 `/`로 시작하지 않으면 여기서 오류가 나고 화면이 비어요. 장바구니의 로그인 버튼이 슬래시 없이 `next=cart`로 넘기고 있었어요 src/app/cart/LoginButton.tsx:18.',
  '',
  '| next 값 | 지금 | 고친 뒤 | 테스트 |',
  '|---|---|---|---|',
  '| `/cart` | 장바구니로 이동 | 그대로 | 통과 |',
  '| `cart` | 빈 화면 (TypeError) | `/cart`로 이동 | 통과 |',
  '| `https://evil.example` | 바깥 사이트로 이동 | 홈으로 | 통과 |',
  '| (없음) | 빈 화면 | 홈으로 | 추가 예정 |',
  '',
  '## 고치는 방법',
  '',
  '1. 같은 사이트 안의 경로만 받는 `safeRedirect()`를 하나 만들어요.',
  '2. 미들웨어와 로그인 액션은 이 함수만 거쳐서 이동해요.',
  '3. 위 표의 네 경우를 테스트로 남겨요.',
  '',
  '```ts',
  "export function safeRedirect(next: string | null, fallback = '/'): string {",
  '  if (!next) return fallback',
  "  const path = next.startsWith('/') ? next : `/${next}`",
  "  return path.startsWith('//') ? fallback : path",
  '}',
  '```',
  '',
  '`new URL()`의 두 번째 인자(base)를 주면 상대 경로도 받아 준다는 점은 [MDN의 URL() 생성자 문서](https://developer.mozilla.org/docs/Web/API/URL/URL)를 따랐어요.',
].join('\n')

const read = (id: string, s: number, file: string, lines: number): ChatItem => ({ id, order: s * 100, at: at(s), kind: 'tool', tool: 'Read', input: { file }, state: 'done', output: { text: '', lines, truncated: false, error: false } })
const grep = (id: string, s: number, pattern: string): ChatItem => ({ id, order: s * 100, at: at(s), kind: 'tool', tool: 'Grep', input: { pattern, path: 'src' }, state: 'done', output: { text: 'src/app/cart/LoginButton.tsx', lines: 1, truncated: false, error: false } })

const ITEMS: ChatItem[] = [
  { id: 'u1', order: 0, at: at(0), kind: 'user', text: '장바구니에서 로그인하면 가끔 빈 화면이 떠요. 스크린샷 붙여요. 원인부터 찾아 주세요.', images: 1 },
  read('r1', 1, 'src/middleware.ts', 58), read('r2', 2, 'src/app/login/actions.ts', 27), read('r3', 3, 'src/app/cart/LoginButton.tsx', 40),
  grep('g1', 4, 'next='), grep('g2', 5, 'new URL('),
  { id: 'a1', order: 600, at: at(9), kind: 'text', text: ANSWER },
  { id: 'e1', order: 650, at: at(10), kind: 'turn-end', durationMs: 108_000 },
  { id: 'u2', order: 700, at: at(60), kind: 'user', text: '좋아요, 그렇게 고쳐 주세요. 테스트도 꼭 넣어 주세요.', images: 0 },
  {
    id: 'd1', order: 800, at: at(70), kind: 'tool', tool: 'Edit', input: { file: 'src/middleware.ts' }, state: 'done',
    diff: {
      file: 'src/middleware.ts', kind: 'edit', added: 4, removed: 1, hidden: 0,
      hunks: [{ oldStart: 38, newStart: 38, lines: [
        { t: ' ', old: 38, new: 38, text: 'export function middleware(req: NextRequest) {' },
        { t: ' ', old: 39, new: 39, text: "  const next = req.nextUrl.searchParams.get('next')" },
        { t: '-', old: 40, new: null, text: '  const url = new URL(next)' },
        { t: '+', old: null, new: 40, text: "  const target = safeRedirect(next, '/')" },
        { t: '+', old: null, new: 41, text: '  if (target !== req.nextUrl.pathname) {' },
        { t: '+', old: null, new: 42, text: '    return NextResponse.redirect(new URL(target, req.url))' },
        { t: '+', old: null, new: 43, text: '  }' },
        { t: ' ', old: 41, new: 44, text: '  return NextResponse.next()' },
        { t: ' ', old: 42, new: 45, text: '}' },
      ] }],
    },
  },
  { id: 'b1', order: 900, at: at(80), kind: 'tool', tool: 'Bash', input: { command: 'npm test', description: 'npm test' }, state: 'done', durationMs: 14_200, output: { text: '✓ tests/safe-redirect.test.ts (4)\n✓ tests/login.test.ts (10)\nTest Files  2 passed (2)', lines: 3, truncated: false, error: false } },
  { id: 'b2', order: 1000, at: at(95), kind: 'tool', tool: 'Bash', input: { command: 'npm run lint' }, state: 'failed', output: { text: 'Exit code 1\nsrc/lib/safe-redirect.ts\n  2:17  error  Missing return type on function\n✖ 1 problem (1 error, 0 warnings)', lines: 4, truncated: false, error: true } },
  { id: 't2', order: 1100, at: at(120), kind: 'text', text: '린트 규칙에 맞춰 반환 타입을 붙였어요. 이제 빌드해서 확인할게요.' },
  { id: 'w1', order: LIVE_BASE + 1, at: at(130), kind: 'tool', tool: 'Bash', input: { command: 'npm run build', description: '빌드해서 확인' }, state: 'running', waiting: 'permission' },
]

const status = (over: Partial<LensStatus> = {}): LensStatus => ({ state: 'waiting', since: at(130), label: null, banner: null, note: null, version: '2.1.323', hasOlder: false, empty: false, ...over })

const STATES: { title: string; note: string; state: ChatState }[] = [
  { title: '대화', note: '읽기 묶음 · 표 · 목록 · 코드 · 링크 · 수정 · 실패 · 허락 대기', state: { rev: 1, items: ITEMS, status: status() } },
  { title: '읽기 실패', note: '배너 + 흐린 대화', state: { rev: 1, items: ITEMS.slice(0, 7), status: status({ state: 'idle', since: null, banner: { reason: 'canary' } }) } },
  { title: '새 세션', note: '빈 상태 (제안 없음)', state: { rev: 1, items: [], status: status({ state: 'idle', since: null, empty: true }) } },
]

const TERM: TerminalInfo = { id: 'qa-chat', sessionId: 'qa-chat', cwd: '', project: 'shop-web', status: 'running', createdAt: T0, exitCode: null, title: '로그인 리다이렉트 고치기', tool: 'claude', chat: 'armed' }
const noop = () => {}

export const QaChat: React.FC = () => {
  const work = useWorkMode()
  const who = chatWho({ name: '모래두지', sprite: iconUrl(27), art: spriteUrl(27) }, work)
  return <>
    {STATES.map(s => (
      <div key={s.title} className="qa-item qa-chat-item">
        <div className="qa-label"><b>{s.title}</b><span>{s.note}</span></div>
        <div className="qa-chat">
          <ChatView term={{ ...TERM, id: `qa-chat-${s.title}` }} who={who} project="shop-web" branch="fix/login-redirect" onTerminal={noop} state={s.state} />
        </div>
      </div>
    ))}
  </>
}

// ---------------------------------------------------------------- 채팅 › 입력란 (the composer)

const QUEUED: Partial<LensStatus> = { queued: [{ text: '끝나면 README의 "로그인" 절에도 바뀐 점 적어 주세요', truncated: false }, { text: '테스트 이름도 정리해 주세요', truncated: false }], queuedCount: 2 }
const NOTES: { title: string; note: Note }[] = [
  { title: '답을 기다리는 중', note: { key: '{name}{iga} 답을 기다리고 있어요. 먼저 답해 주세요', vars: { name: '모래두지', iga: '가' }, terminal: true } },
  { title: '화면을 못 읽음', note: { key: '터미널이 지금 입력을 받을 수 있는지 확인하지 못했어요', terminal: true } },
  { title: '터미널에 쓰던 글', note: { key: '터미널 입력란에 쓰던 글이 있어요. 터미널에서 보내거나 지운 뒤 다시 보내 주세요', terminal: true } },
  { title: 'Enter를 못 누름', note: { key: '보낸 글은 터미널 입력란에 남아 있어요. 터미널에서 Enter를 누르거나 지워 주세요', terminal: true } },
  { title: '명령 보냄', note: { key: '{command} 보냈어요. 터미널에 화면이 열렸다면 거기서 이어서 해 주세요', vars: { command: '/compact' }, terminal: true } },
  { title: '이미지 형식', note: { key: 'PNG, JPEG, GIF, WebP 이미지만 붙일 수 있어요' } },
]

export const QaComposer: React.FC = () => {
  const work = useWorkMode()
  const who = chatWho({ name: '모래두지', sprite: iconUrl(27), art: spriteUrl(27) }, work)
  const control: ComposerControl = { model: 'Opus 5.5', context: { left: 62, tip: '남은 컨텍스트 62%', label: work ? '컨텍스트' : 'HP' }, usage: { fiveHour: 46, weekly: 82 } }
  const fixed = (over: Partial<LensStatus> = {}, items: ChatItem[] = []): ChatState => ({ rev: 1, items, status: status({ state: 'idle', since: null, mode: 'acceptEdits', ...over }) })
  const term = (n: string) => ({ ...TERM, id: `qa-compose-${n}` })
  const pics = [{ token: 'a'.repeat(24), url: spriteUrl(27), n: 1 }, { token: 'b'.repeat(24), url: spriteUrl(25), n: 2 }]
  const box = (key: string, title: string, note: string, body: React.ReactNode, tall = false) => (
    <div key={key} className="qa-item qa-chat-item">
      <div className="qa-label"><b>{title}</b><span>{note}</span></div>
      <div className={`qa-chat qa-composer${tall ? ' tall' : ''}`}><div className="chat">{body}</div></div>
    </div>
  )
  const composer = (n: string, over: Partial<React.ComponentProps<typeof Composer>> = {}, state = fixed()) => (
    <Composer term={term(n)} who={who} onTerminal={noop} control={control} state={state} deps={{ chat: null }} {...over} />
  )
  const pendingUser = (id: string, text: string, pending: 'sending' | 'unconfirmed', n: number): ChatItem => ({ id, order: PENDING_BASE + n, at: at(200 + n), kind: 'user', text, images: 0, pending, local: id })
  const working = fixed({ state: 'working', since: at(130) }, [...ITEMS.slice(0, 7), pendingUser('p1', '빌드 끝나면 주석 한 줄만 더 달아 주세요', 'sending', 0), pendingUser('p2', '테스트 이름도 정리해 주세요', 'sending', 1)])
  return <>
    {box('empty', '빈 입력란', '모델 · 권한 모드 · HP(컨텍스트) · 사용량, 보내기는 흐리게', composer('empty'))}
    {box('draft', '두 줄 + 이미지 두 장', '보내기만 노랑 · 칩은 선 · 대기 중 2가 위에 붙음', composer('draft', { preview: { text: '빌드 끝나면 src/lib/safe-redirect.ts 에\n주석 한 줄만 더 달아 주세요', chips: pics } }, fixed(QUEUED)))}
    {box('slash', '/로 시작', '명령으로 보낸다는 안내 · 명령 메뉴는 ?system 채팅에', composer('slash', { preview: { text: '/compact' } }))}
    {NOTES.map(n => box(`note-${n.title}`, `안내 · ${n.title}`, '조용한 글, 필요하면 터미널로 보기', composer(`note-${n.title}`, { preview: { note: n.note } })))}
    {box('working', '일하는 중 · 보내는 중', '일하는 줄의 멈추기(잉크) · 보내는 중…',
      <ChatView term={term('working')} who={who} project="shop-web" branch="fix/login-redirect" onTerminal={noop} onStop={noop} state={working}
        footer={composer('working', {}, working)} />, true)}
  </>
}

// ---------------------------------------------------------------- 채팅 › 답하기 (the answer cards)

const ASK = { toolId: null, agent: false, always: null, state: 'open', since: at(130) } as const
const EDIT_LINES = [
  { t: ' ', old: 1, new: 1, text: 'export function middleware(req: NextRequest) {' },
  { t: ' ', old: 2, new: 2, text: "  const next = req.nextUrl.searchParams.get('next')" },
  { t: '-', old: 3, new: null, text: '  const url = new URL(next)' },
  { t: '+', old: null, new: 3, text: "  const target = safeRedirect(next, '/')" },
  { t: '+', old: null, new: 4, text: '  return NextResponse.redirect(new URL(target, req.url))' },
  { t: ' ', old: 4, new: 5, text: '}' },
] as const
const PLAN = [
  '# 계획: 리다이렉트 고치기',
  '',
  '1. `safeRedirect()`를 만들어요.',
  '2. 미들웨어와 로그인 액션이 이 함수만 쓰게 해요.',
  '3. 네 경우를 테스트로 남겨요.',
  '4. 린트와 빌드를 돌려요.',
  '5. README의 로그인 절을 고쳐요.',
  '6. 바뀐 점을 정리해요.',
  '7. 커밋은 하지 않아요.',
].join('\n')
const CARDS: { title: string; note: string; card: AskCard; more?: number }[] = [
  { title: '명령 실행', note: '허용(잉크) · 항상 허용(세션 규칙) · 거부(선) · 거부하면 … · 터미널에서 보기', more: 1,
    card: { ...ASK, key: 'qa-bash', holdId: 'qa-bash', kind: 'permission', toolId: 'w1', tool: 'Bash', input: { command: 'npm run build', description: '고친 리다이렉트가 빌드되는지 확인하려고 해요' }, always: { rule: 'Bash(npm run build)' } } },
  { title: '파일 수정', note: '파일과 바뀌는 줄 전부(스크롤) · 항상 허용 없음',
    card: { ...ASK, key: 'qa-edit', holdId: 'qa-edit', kind: 'permission', tool: 'Edit', input: { file: 'src/middleware.ts' }, diff: { file: 'src/middleware.ts', kind: 'edit', added: 2, removed: 1, hidden: 0, hunks: [{ oldStart: 1, newStart: 1, lines: EDIT_LINES.map(l => ({ ...l })) }] } } },
  { title: '보조 에이전트', note: '보조 에이전트의 요청 · 숨은 글자는 [U+…]로',
    card: { ...ASK, key: 'qa-agent', holdId: 'qa-agent', kind: 'permission', agent: true, tool: 'PowerShell', input: { command: 'Get-Content notes.txt' + String.fromCharCode(0x202e) + 'txt.exe | Measure-Object -Line' }, always: { rule: 'PowerShell(Get-Content notes.txt)' } } },
  { title: '질문', note: '고르기 하나 · 설명은 아래 · 터미널에서 답하기',
    card: { ...ASK, key: 'qa-q', holdId: 'qa-q', kind: 'question', tool: 'AskUserQuestion', input: {}, question: { text: 'README의 로그인 절도 같이 고칠까요?', header: 'README', options: [{ label: '네', description: '바뀐 리다이렉트 규칙을 README에도 적어요' }, { label: '아니요', description: '코드만 고쳐요' }] } } },
  { title: '계획', note: '읽기만 · 처음 여섯 줄 · 더 보기 · 터미널에서 답하기(잉크)',
    card: { ...ASK, key: 'qa-plan', holdId: null, kind: 'plan', tool: 'ExitPlanMode', input: { plan: PLAN }, state: 'terminal' } },
  { title: '보냄', note: '허용을 보냈어요 · 확인 중 (Claude Code가 한 일로 사라짐)',
    card: { ...ASK, key: 'qa-sent', holdId: 'qa-sent', kind: 'permission', tool: 'Bash', input: { command: 'npm test' }, state: 'sent', sent: 'allow' } },
  { title: '시간 지남', note: '답할 시간이 지나 터미널로 · 터미널에서 답하기',
    card: { ...ASK, key: 'qa-timeout', holdId: 'qa-timeout', kind: 'permission', tool: 'WebFetch', input: { url: 'https://developer.mozilla.org/docs/Web/API/URL/URL' }, state: 'timeout' } },
]

export const QaAnswers: React.FC = () => {
  const work = useWorkMode()
  const who = chatWho({ name: '모래두지', sprite: iconUrl(27), art: spriteUrl(27) }, work)
  const control: ComposerControl = { model: 'Opus 5.5', context: { left: 62, tip: '남은 컨텍스트 62%', label: work ? '컨텍스트' : 'HP' }, usage: { fiveHour: 46, weekly: 82 } }
  const never = () => new Promise<never>(() => {})
  const first = CARDS[0]
  const inView: ChatState = { rev: 1, items: ITEMS, status: status({ asks: [first.card, CARDS[1].card] }) }
  return <>
    {CARDS.map(c => (
      <div key={c.title} className="qa-item qa-chat-item">
        <div className="qa-label"><b>{c.title}</b><span>{c.note}</span></div>
        <div className="qa-chat qa-composer"><div className="chat">
          <AnswerSurface id={`qa-answer-${c.card.key}`} asks={c.more ? [c.card, CARDS[1].card] : [c.card]} who={who} answer={never} onTerminal={noop} />
        </div></div>
      </div>
    ))}
    <div className="qa-item qa-chat-item">
      <div className="qa-label"><b>대화 안에서</b><span>목록과 입력란 사이 · 주황 알약 대신 · 멈추기 없음</span></div>
      <div className="qa-chat qa-composer tall"><div className="chat">
        <ChatView term={{ ...TERM, id: 'qa-answer-view' }} who={who} project="shop-web" branch="fix/login-redirect" onTerminal={noop} onStop={noop} state={inView}
          footer={<Composer term={{ ...TERM, id: 'qa-answer-view' }} who={who} onTerminal={noop} control={control} state={inView} deps={{ chat: null }} />} />
      </div></div>
    </div>
  </>
}

export default QaChat
