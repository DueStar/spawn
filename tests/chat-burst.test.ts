/**
 * A long answer arriving at once (the owner's "I have to reload to see it", 2026-11-19): the
 * transcript written in pieces that split a long Korean line mid-character and mid-line, a
 * huge single append, many lines at once — every message reaches the page's state through
 * the live reader (chatLens.cjs over chatTail.cjs) and the page's store, with no reload.
 */

import fs, { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyUpdate, EMPTY_CHAT, type ChatState } from '../src/chat/store'

const require = createRequire(import.meta.url)
const { createLens } = require('../electron/chatLens.cjs')
const { callKey } = require('../hooks/spawn-hook.cjs')

const PROJECT = 'C--Users-user-work-demo'
const CWD = 'C:\\Users\\user\\work\\demo'
const T1 = '11111111-1111-4111-8111-111111111111'
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-chat-burst-')); dirs.push(d); return d }

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.setSystemTime(new Date('2026-11-19T12:00:00Z')) })
afterEach(() => { vi.useRealTimers() })

const userLine = (n: number, text: string, parent: string | null) => JSON.stringify({ parentUuid: parent, isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid: uuid(n), timestamp: '2026-11-19T12:00:00.000Z' })
const answerLine = (n: number, text: string, parent: string) => JSON.stringify({ parentUuid: parent, isSidechain: false, type: 'assistant', message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn' }, uuid: uuid(n), timestamp: '2026-11-19T12:00:01.000Z' })
const bigLine = (bytes: number) => JSON.stringify({ type: 'attachment', attachment: { type: 'prompt_snapshot', data: 'x'.repeat(bytes) }, uuid: uuid(999), timestamp: '2026-11-19T12:00:01.000Z' })

function setup() {
  const claudeDir = tempDir()
  const userDataDir = tempDir()
  mkdirSync(join(claudeDir, 'projects', PROJECT), { recursive: true })
  mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
  let page: ChatState = EMPTY_CHAT
  const gaps: number[] = []
  const lens = createLens({
    claudeDir, userDataDir, fs, callKey, watch: () => null,
    emit: (u: any) => { const r = applyUpdate(page, u); if (r.gap) gaps.push(u.rev); page = r.state },
  })
  const file = join(claudeDir, 'projects', PROJECT, `${T1}.jsonl`)
  const run = async (ms: number) => { for (let t = 0; t < ms; t += 10) { vi.advanceTimersByTime(Math.min(10, ms - t)); await lens.idle() } await lens.idle() }
  const texts = () => page.items.filter(i => i.kind === 'text' || i.kind === 'user').map(i => (i as any).text as string)
  return { lens, file, run, texts, gaps, page: () => page }
}

/** Bytes appended in pieces cut at the given byte positions (mid-character, mid-line), the reader polling in between */
async function appendInPieces(file: string, bytes: Buffer, cuts: number[], run: (ms: number) => Promise<void>) {
  let from = 0
  for (const at of [...cuts, bytes.length]) {
    appendFileSync(file, bytes.subarray(from, at))
    from = at
    await run(300)
  }
}

describe('a burst of transcript lines reaches the page live', () => {
  it('a long Korean answer split mid-character and mid-line, across many polls', async () => {
    const { lens, file, run, texts, gaps } = setup()
    writeFileSync(file, userLine(1, '안녕', null) + '\n')
    lens.setTerminals([{ id: T1, cwd: CWD, armed: true, status: 'running' }])
    lens.open(T1)
    await run(50)
    expect(texts()).toEqual(['안녕'])

    const long = '가나다라마바사 아자차카타파하. '.repeat(4000) // ~ 100 KB of 3-byte characters
    const tail = userLine(3, '고마워요 다음 질문이에요', uuid(2))
    const bytes = Buffer.from(answerLine(2, long, uuid(1)) + '\n' + tail + '\n', 'utf8')
    // cut inside a 3-byte character (the first byte of 가 is 0xea), inside the JSON, and right before the newline
    const ko = bytes.indexOf(Buffer.from('가', 'utf8'), 300)
    const cuts = [ko + 1, ko + 2, 70_000 + 1, bytes.indexOf(0x0a) , bytes.indexOf(0x0a) + 5]
    await appendInPieces(file, bytes, cuts, run)
    await run(5000)
    expect(gaps).toEqual([])
    expect(texts()).toEqual(['안녕', long.trim() === long ? long : expect.any(String), '고마워요 다음 질문이에요'])
    expect(texts()[1].startsWith('가나다라마바사')).toBe(true)
  })

  it('one huge append (several MB, many lines) in a single write', async () => {
    const { lens, file, run, texts, gaps, page } = setup()
    writeFileSync(file, userLine(1, '시작', null) + '\n')
    lens.setTerminals([{ id: T1, cwd: CWD, armed: true, status: 'running' }])
    lens.open(T1)
    await run(50)
    const lines: string[] = [bigLine(3 << 20)]
    let parent = uuid(1)
    for (let n = 10; n < 210; n += 2) {
      lines.push(answerLine(n, `답 ${n}: ${'한글 문장이 길게 이어집니다. '.repeat(50)}`, parent))
      lines.push(userLine(n + 1, `질문 ${n + 1}`, uuid(n)))
      parent = uuid(n + 1)
    }
    appendFileSync(file, lines.join('\n') + '\n')
    await run(1200)
    expect(gaps).toEqual([])
    expect(texts().length).toBe(1 + 200)
    expect(texts()[texts().length - 1]).toBe('질문 209')
    expect(page().status?.banner ?? null).toBeNull()
  })

  it('streamed, then Stop, then the answer written late in one big append', async () => {
    const { lens, file, run, texts, gaps, page } = setup()
    writeFileSync(file, userLine(1, '시작', null) + '\n')
    lens.setTerminals([{ id: T1, cwd: CWD, armed: true, status: 'running' }])
    lens.open(T1)
    await run(50)
    const base = { session_id: T1, transcript_path: file, cwd: CWD }
    lens.hook('UserPromptSubmit', { ...base, prompt: '긴 답을 주세요' }, Date.now())
    await run(20)
    appendFileSync(file, userLine(2, '긴 답을 주세요', uuid(1)) + '\n')
    await run(300)
    const answer = '한국어로 길게 답합니다. '.repeat(3000)
    const deltas = answer.match(/[\s\S]{1,500}/g)!
    deltas.forEach((delta, index) => lens.hook('MessageDisplay', { ...base, message_id: 'm1', turn_id: 'x', index, final: index === deltas.length - 1, delta }, Date.now()))
    await run(50)
    const live = () => page().items.filter(i => i.kind === 'live').map(i => (i as any).text)
    expect(live()).toEqual([answer])
    lens.hook('Stop', { ...base, last_assistant_message: answer.trim(), stop_hook_active: false }, Date.now())
    await run(4000) // the canary's 3 s pass first
    appendFileSync(file, [answerLine(3, answer.trim(), uuid(2)), bigLine(170_000)].join('\n') + '\n')
    await run(1500)
    expect(gaps).toEqual([])
    expect(texts()).toEqual(['시작', '긴 답을 주세요', answer.trim()])
    expect(live()).toEqual([])
    expect(page().status?.banner ?? null).toBeNull()
    expect(page().status?.state).toBe('idle')
  })

  it('a wake-up turn whose answer is read before its Stop arrives: no canary banner, the answer stays', async () => {
    const { lens, file, run, texts, page } = setup()
    writeFileSync(file, userLine(1, '시작', null) + '\n')
    lens.setTerminals([{ id: T1, cwd: CWD, armed: true, status: 'running' }])
    lens.open(T1)
    await run(50)
    const base = { session_id: T1, transcript_path: file, cwd: CWD }
    const wake = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent done</summary>\n</task-notification>'
    lens.hook('UserPromptSubmit', { ...base, prompt: wake }, Date.now())
    await run(20)
    const answer = '백그라운드 작업이 끝났어요. 결과를 정리하면 이렇습니다.'
    appendFileSync(file, userLine(2, wake, uuid(1)) + '\n' + answerLine(3, answer, uuid(2)) + '\n')
    await run(300) // read before the Stop hook reaches the lens
    expect(texts()).toContain(answer)
    lens.hook('Stop', { ...base, last_assistant_message: answer, stop_hook_active: false }, Date.now())
    await run(4000)
    expect(page().status?.banner ?? null).toBeNull()
    expect(texts()).toContain(answer)
  })
})
