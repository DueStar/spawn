/**
 * A prompt another plugin's UserPromptSubmit hook blocked (2026-11-23: claude-mem's worker could not be reached).
 * The record says so in a system line; the chat says so once (never "not in the record yet"), the hook's early
 * bubble and the composer's own go, the session is idle again, and the words left on the terminal's prompt row
 * are the chat's own to clear.
 */
import fs, { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOutbox, reconcile, STALE_MS, type OutboxEntry } from '../src/chat/outbox'
import { ownLeftover } from '../src/chat/clearRow'
import { noticeText } from '../src/chat/find'
import { applyUpdate, EMPTY_CHAT, type ChatState } from '../src/chat/store'
import type { ChatItem, LensStatus } from '../src/chat/types'
import { itemProblems } from './chat-helpers'

const require = createRequire(import.meta.url)
const { createItemBuilder } = require('../electron/chatItems.cjs')
const { createLens } = require('../electron/chatLens.cjs')
const { callKey } = require('../hooks/spawn-hook.cjs')
const { quickSkip } = require('../electron/chatSchema.cjs')

const PROJECT = 'C--Users-user-work-demo'
const CWD = 'C:\\Users\\user\\work\\demo'
const T1 = '11111111-1111-4111-8111-111111111111'
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const blockedLine = (n: number, prompt: string, parent: string | null) => JSON.stringify({
  parentUuid: parent, isSidechain: false, type: 'system', subtype: 'informational',
  content: `UserPromptSubmit operation blocked by hook:\n[node "C:/x/worker-service.cjs" hook claude-code session-init]: claude-mem worker unreachable for 64 consecutive hooks.\n\nThis hook comes from the claude-mem@thedotmack plugin.\n\nOriginal prompt: ${prompt}`,
  isMeta: false, timestamp: '2026-11-23T02:01:14.584Z', uuid: uuid(n), level: 'warning', preventContinuation: true,
  promptSubmitEnding: { ending: { kind: 'blocked_by_hook', reason: 'claude-mem worker unreachable for 64 consecutive hooks.' }, promptKept: false },
})
const userLine = (n: number, text: string, parent: string | null) => JSON.stringify({ parentUuid: parent, isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid: uuid(n), timestamp: '2026-11-19T12:00:00.000Z' })
const answerLine = (n: number, text: string, parent: string) => JSON.stringify({ parentUuid: parent, isSidechain: false, type: 'assistant', message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn' }, uuid: uuid(n), timestamp: '2026-11-19T12:00:01.000Z' })

describe("the record's line for a blocked prompt", () => {
  it('is a prompt-blocked notice: the prompt (when it reads cleanly) and the plugin that blocked it', () => {
    expect(quickSkip(blockedLine(1, 'hi', null))).toBe(false)
    const [it1] = createItemBuilder({ cwd: CWD }).line(JSON.parse(blockedLine(1, '세 가지 요청이에요', null)), 100)
    expect(it1).toMatchObject({ kind: 'notice', notice: 'prompt-blocked', text: '세 가지 요청이에요', by: 'claude-mem' })
    expect(itemProblems(it1)).toEqual([])
    // (Claude Code wrote the prompt through the hook's code page: mangled, it is not shown)
    const [it2] = createItemBuilder({ cwd: CWD }).line(JSON.parse(blockedLine(2, '\ufffd\ufffd ä\ufffd\ufffd', null)), 200)
    expect(it2.notice).toBe('prompt-blocked')
    expect(it2.text).toBeUndefined()
  })
  it('is said once, plainly, naming the plugin', () => {
    const { text } = noticeText({ id: 'x', order: 1, at: 0, kind: 'notice', notice: 'prompt-blocked', by: 'claude-mem' } as any)
    expect(text).toContain('claude-mem')
    expect(text).toContain('보내지 못했어요')
  })
})

const dirs: string[] = []
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-chat-blocked-')); dirs.push(d); return d }

describe('the lens, when the record says the prompt was blocked', () => {
  it("drops the hook's early bubble, and the session is idle again (no missing banner later)", async () => {
    const claudeDir = tempDir()
    const userDataDir = tempDir()
    mkdirSync(join(claudeDir, 'projects', PROJECT), { recursive: true })
    mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
    let page: ChatState = EMPTY_CHAT
    const lens = createLens({ claudeDir, userDataDir, fs, callKey, watch: () => null, emit: (u: any) => { page = applyUpdate(page, u).state } })
    const file = join(claudeDir, 'projects', PROJECT, `${T1}.jsonl`)
    writeFileSync(file, userLine(1, '처음 질문', null) + '\n' + answerLine(2, '처음 답', uuid(1)) + '\n')
    const run = async (ms: number) => { for (let t = 0; t < ms; t += 10) { vi.advanceTimersByTime(Math.min(10, ms - t)); await lens.idle() } await lens.idle() }
    lens.setTerminals([{ id: T1, cwd: CWD, armed: true, status: 'running' }])
    lens.open(T1)
    await run(50)
    const base = { session_id: T1, transcript_path: file, cwd: CWD }
    lens.hook('UserPromptSubmit', { ...base, prompt: '막힐 질문이에요', prompt_id: 'p9' }, Date.now())
    await run(20)
    expect(page.items.some(i => i.id === 'prompt:p9')).toBe(true)
    appendFileSync(file, blockedLine(3, '막힐 질문이에요', uuid(2)) + '\n')
    await run(1100)
    expect(page.items.some(i => i.id === 'prompt:p9')).toBe(false)
    expect(page.items.some(i => i.kind === 'notice' && (i as any).notice === 'prompt-blocked')).toBe(true)
    expect(page.status?.state).toBe('idle')
    await run(70_000)
    expect(page.status?.banner ?? null).toBeNull()
  })
})

const STATUS: LensStatus = { state: 'idle', since: null, label: null, banner: null, note: null, version: null, hasOlder: false, empty: false }
const entry = (o: Partial<OutboxEntry> = {}): OutboxEntry => ({ local: 'l1', text: '세 가지 요청이에요', images: [], state: 'sent', at: 1000, sentAt: 1000, baseline: 500, ...o })
const blocked = (order: number, text?: string): ChatItem => ({ id: `b${order}`, order, at: 2000, kind: 'notice', notice: 'prompt-blocked', ...(text ? { text } : {}) } as any)

describe("the composer's bubble of a blocked prompt", () => {
  it('goes: the notice stands for it (matched by its words, or, mangled, by being the oldest one sent before it)', () => {
    expect(reconcile([entry()], [blocked(600, '세 가지 요청이에요')], STATUS, 3000)).toEqual({ entries: [], matched: [{ local: 'l1', itemId: null }] })
    const two = [entry({ local: 'a' }), entry({ local: 'b', text: '다음 것', at: 1500, sentAt: 1500 })]
    expect(reconcile(two, [blocked(600)], STATUS, 3000).matched).toEqual([{ local: 'a', itemId: null }])
    // (a notice from before the message was sent is not its)
    expect(reconcile([entry({ baseline: 700 })], [blocked(600)], STATUS, 3000).matched).toEqual([])
  })
  it('never says "not in the record yet": a bubble the record has not shown stays plain, and goes once the session is idle a while', () => {
    const r = reconcile([entry()], [], { ...STATUS, state: 'working' }, 1000 + STALE_MS + 1)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0].state).toBe('sent')
    expect(reconcile([entry()], [], STATUS, 1000 + STALE_MS - 1).entries).toHaveLength(1)
    expect(reconcile([entry()], [], STATUS, 1000 + STALE_MS + 1).entries).toEqual([])
    const o = createOutbox({ revoke: () => {} })
    o.add(entry({ state: 'sending' }))
    o.mark('l1', 'sent', 1000)
    o.sync([], STATUS, 1000 + STALE_MS + 1)
    expect(o.entries()).toEqual([])
  })
  it('the bubble draws no "기록에서 아직 보이지 않아요" any more', () => {
    const src = readFileSync(join(__dirname, '..', 'src/components/chat/UserMessage.tsx'), 'utf8')
    expect(src).not.toContain('기록에서 아직 보이지 않아요')
  })
})

describe("the words the chat sent, left on the terminal's prompt row", () => {
  it("are the chat's own to clear (the same words as a message it sent lately); anything else is the user's", () => {
    expect(ownLeftover('세 가지 요청이에요', ['다른 것', '세 가지 요청이에요'])).toBe(true)
    // (the row shows a long message cut, or wrapped)
    const long = '그리고 세션 여러개 띄울때 좌 우 위치중에 선택해서 넣을 수 있게 영역을 미리 보여주고'
    expect(ownLeftover(long.slice(0, 30), [long])).toBe(true)
    expect(ownLeftover('내가 터미널에 직접 친 글', ['세 가지 요청이에요'])).toBe(false)
    expect(ownLeftover('세', ['세 가지 요청이에요'])).toBe(false)
    expect(ownLeftover('', ['x'])).toBe(false)
  })
  it('the composer clears them before a send, without asking, and when the record says a prompt was blocked', () => {
    const src = readFileSync(join(__dirname, '..', 'src/components/chat/Composer.tsx'), 'utf8')
    expect(src).toContain('ownLeftover(')
    expect(src).toMatch(/prompt-blocked/)
  })
})
