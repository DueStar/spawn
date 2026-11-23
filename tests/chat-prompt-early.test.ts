/**
 * The prompt shown at once (so a sent prompt shows immediately). Measured on
 * Claude Code 2.1.328: UserPromptSubmit reaches spawn's HTTP hook 0.13 s after Enter, but the prompt's own
 * transcript line waits for every UserPromptSubmit hook (another plugin's 6 s hook held it 6.4 s; claude-mem:
 * 12 s). The lens shows the prompt from its hook (electron/chatLens.cjs showPrompt) in the same update as
 * `working`; its line replaces it; the composer's bubble stands for it and is never "unconfirmed" meanwhile.
 */

import fs, { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hookPromptsShown, reconcile, UNCONFIRMED_MS, type OutboxEntry } from '../src/chat/outbox'
import { applyUpdate, EMPTY_CHAT, type ChatState } from '../src/chat/store'
import { LIVE_BASE, type ChatItem } from '../src/chat/types'
import { itemProblems } from './chat-helpers'

const require = createRequire(import.meta.url)
const { createLens } = require('../electron/chatLens.cjs')
const { callKey } = require('../hooks/spawn-hook.cjs')

const PROJECT = 'C--Users-user-work-demo'
const CWD = 'C:\\Users\\user\\work\\demo'
const T1 = '11111111-1111-4111-8111-111111111111'
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-chat-prompt-')); dirs.push(d); return d }

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.setSystemTime(new Date('2026-11-19T12:00:00Z')) })
afterEach(() => { vi.useRealTimers() })

const userLine = (n: number, text: string, parent: string | null) => JSON.stringify({ parentUuid: parent, isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid: uuid(n), timestamp: '2026-11-19T12:00:00.000Z' })
const answerLine = (n: number, text: string, parent: string) => JSON.stringify({ parentUuid: parent, isSidechain: false, type: 'assistant', message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn' }, uuid: uuid(n), timestamp: '2026-11-19T12:00:01.000Z' })

async function setup() {
  const claudeDir = tempDir()
  const userDataDir = tempDir()
  mkdirSync(join(claudeDir, 'projects', PROJECT), { recursive: true })
  mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
  let page: ChatState = EMPTY_CHAT
  const updates: any[] = []
  const lens = createLens({
    claudeDir, userDataDir, fs, callKey, watch: () => null,
    emit: (u: any) => { updates.push(u); page = applyUpdate(page, u).state },
  })
  const file = join(claudeDir, 'projects', PROJECT, `${T1}.jsonl`)
  writeFileSync(file, userLine(1, '처음 질문', null) + '\n' + answerLine(2, '처음 답', uuid(1)) + '\n')
  const run = async (ms: number) => { for (let t = 0; t < ms; t += 10) { vi.advanceTimersByTime(Math.min(10, ms - t)); await lens.idle() } await lens.idle() }
  lens.setTerminals([{ id: T1, cwd: CWD, armed: true, status: 'running' }])
  lens.open(T1)
  await run(50)
  const base = { session_id: T1, transcript_path: file, cwd: CWD }
  const prompts = () => page.items.filter(i => i.kind === 'user' && (i as any).pending) as any[]
  return { lens, file, run, base, updates, page: () => page, prompts }
}

describe('the prompt from its hook', () => {
  it('shows with `working` in the hook\'s own update, and its line replaces it in one update', async () => {
    const { lens, file, run, base, updates, page, prompts } = await setup()
    const from = updates.length
    lens.hook('UserPromptSubmit', { ...base, prompt: '두 번째 질문이에요', prompt_id: 'p2' }, Date.now())
    // (synchronously: no timer, no read in between)
    const first = updates[from]
    expect(first.ops.some((o: any) => o.op === 'status' && o.status.state === 'working')).toBe(true)
    const row = first.ops.find((o: any) => o.op === 'upsert').items[0]
    expect(row).toMatchObject({ id: 'prompt:p2', kind: 'user', text: '두 번째 질문이에요', pending: 'sent' })
    expect(row.order).toBeGreaterThan(LIVE_BASE)
    expect(itemProblems(row)).toEqual([])
    // the record writes the line seconds later (another plugin's hook): the row stays meanwhile
    await run(6000)
    expect(prompts().map(p => p.text)).toEqual(['두 번째 질문이에요'])
    expect(page().status?.banner ?? null).toBeNull()
    const at = updates.length
    appendFileSync(file, userLine(3, '두 번째 질문이에요', uuid(2)) + '\n')
    await run(1100)
    const swap = updates.slice(at).find(u => u.ops.some((o: any) => o.op === 'remove'))
    expect(swap.ops.find((o: any) => o.op === 'remove').ids).toEqual(['prompt:p2'])
    expect(swap.ops.find((o: any) => o.op === 'upsert').items.some((i: any) => i.kind === 'user' && i.text === '두 번째 질문이에요' && !i.pending)).toBe(true)
    expect(prompts()).toEqual([])
    expect(page().items.filter(i => i.kind === 'user').map(i => (i as any).text)).toEqual(['처음 질문', '두 번째 질문이에요'])
  })

  it('no row for a slash command, a wake-up, a prompt mid-turn, or the newest line again', async () => {
    const { lens, run, base, prompts } = await setup()
    lens.hook('UserPromptSubmit', { ...base, prompt: '/model opus' }, Date.now())
    await run(20)
    expect(prompts()).toEqual([])
    lens.hook('Stop', { ...base, last_assistant_message: '' }, Date.now())
    await run(4000)
    lens.hook('UserPromptSubmit', { ...base, prompt: '<task-notification>\n<task-id>a</task-id>\n<summary>done</summary>\n</task-notification>' }, Date.now())
    await run(20)
    expect(prompts()).toEqual([])
    // mid-turn (Claude Code's queue strip says it)
    lens.hook('UserPromptSubmit', { ...base, prompt: '이것도 해 주세요' }, Date.now())
    await run(20)
    expect(prompts()).toEqual([])
    lens.hook('Stop', { ...base, last_assistant_message: '' }, Date.now())
    await run(4000)
    lens.hook('UserPromptSubmit', { ...base, prompt: '처음 질문' }, Date.now())
    await run(20)
    expect(prompts()).toEqual([])
  })

  it('goes with the turn when its line never comes (Esc before the record wrote it)', async () => {
    const { lens, file, run, base, prompts } = await setup()
    lens.hook('UserPromptSubmit', { ...base, prompt: '멈출 질문' }, Date.now())
    await run(20)
    expect(prompts().length).toBe(1)
    appendFileSync(file, userLine(3, '[Request interrupted by user]', uuid(2)) + '\n')
    await run(1100)
    expect(prompts()).toEqual([])
  })
})

describe('the composer\'s bubble and the prompt from its hook', () => {
  const entry = (over: Partial<OutboxEntry> = {}): OutboxEntry => ({ local: 'a1', text: '두 번째 질문이에요', images: [], state: 'sent', at: 0, sentAt: 0, baseline: 10, ...over })
  const hookRow: ChatItem = { id: 'prompt:p2', order: LIVE_BASE + 1, at: 0, kind: 'user', text: '두 번째 질문이에요', images: 0, pending: 'sent' }

  it('is never "unconfirmed" while Claude Code has taken it (its line is only late)', () => {
    expect(reconcile([entry()], [], null, UNCONFIRMED_MS + 1).entries[0].state).toBe('sent')
    const r = reconcile([entry()], [hookRow], null, 12_000)
    expect(r.entries).toEqual([entry()])
    expect(r.matched).toEqual([])
    // (said too early, then the hook's row came: back to sent)
    expect(reconcile([entry({ state: 'unconfirmed' })], [hookRow], null, 12_000).entries[0].state).toBe('sent')
  })

  it('stands for the hook\'s row, so the page shows one bubble, not two', () => {
    expect([...hookPromptsShown([entry()], [hookRow])]).toEqual(['prompt:p2'])
    expect([...hookPromptsShown([entry({ text: '다른 글' })], [hookRow])]).toEqual([])
    expect([...hookPromptsShown([], [hookRow])]).toEqual([])
  })
})
