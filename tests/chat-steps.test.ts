/**
 * Steps in the turn summary: src/chat/steps.ts. Two reads of the game server's existing
 * read-only GET /pokedex bracket a turn: a start sample when the session goes to work, an end sample 1.5 s after a
 * turn end that arrived live, taken only while the session is not working again. The count is shown only when the
 * bracket is exact (an unused start of the same session, the same Pokémon at both reads, no other turn end between);
 * otherwise nothing. In 업무 모드 there is no ledger and no read at all. src/chat/store.ts tells the live turn ends
 * (an upsert past the end of what was held) from the history (a reset, an older page).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { END_DELAY_MS, RESULTS_PER_SESSION, createStepLedger, sampleOf, stepLedgerFor } from '../src/chat/steps'
import { createChatStore } from '../src/chat/store'
import type { ChatItem, ChatUpdate, LensStatus } from '../src/chat/types'

const ROOT = join(__dirname, '..')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')

const dex = (steps: number, uid = 'u1', sid = 's-1') => ({ assign: { [sid]: uid, other: 'u9' }, mons: { [uid]: { uid, steps }, u9: { uid: 'u9', steps: 999 } } })

/** A fetch that answers from a list (a value, or an Error to reject), counting its calls */
function fakeFetch(answers: unknown[]) {
  const fn = vi.fn(() => {
    const a = answers.shift()
    return a instanceof Error || a === undefined ? Promise.reject(a ?? new Error('no answer')) : Promise.resolve(a)
  })
  return fn
}

let clock = 1_000_000
const now = () => clock
const idle = () => 'idle' as const
const working = () => 'working' as const

beforeEach(() => { vi.useFakeTimers(); clock = 1_000_000 })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

async function settle(ms = 0) {
  clock += ms
  await vi.advanceTimersByTimeAsync(ms)
}

describe('sampleOf', () => {
  it('the session\'s Pokémon and its steps, or null for anything else', () => {
    expect(sampleOf(dex(10), 's-1', 5)).toEqual({ at: 5, uid: 'u1', steps: 10 })
    expect(sampleOf(dex(10), 's-2', 5)).toBeNull()
    expect(sampleOf({ assign: { 's-1': 'u1' }, mons: {} }, 's-1', 5)).toBeNull()
    expect(sampleOf({ assign: { 's-1': 'u1' }, mons: { u1: { steps: -1 } } }, 's-1', 5)).toBeNull()
    expect(sampleOf({ assign: { 's-1': 'u1' }, mons: { u1: { steps: '3' } } }, 's-1', 5)).toBeNull()
    expect(sampleOf(null, 's-1', 5)).toBeNull()
    expect(sampleOf('x', 's-1', 5)).toBeNull()
  })
})

describe('the exact bracket', () => {
  it('start 10 → end 18 gives 8 (the end read 1.5 s after the turn end, while idle)', async () => {
    const fetchDex = fakeFetch([dex(10), dex(18)])
    const l = createStepLedger({ fetchDex, now })
    const heard = vi.fn()
    l.subscribe(heard)
    l.onWorking('s-1')
    await settle(5000)
    expect(fetchDex).toHaveBeenCalledTimes(1)
    l.onTurnEnd('s-1', 'e1', idle)
    await settle(END_DELAY_MS - 1)
    expect(fetchDex).toHaveBeenCalledTimes(1)
    expect(l.stepsFor('e1')).toBeNull()
    await settle(1)
    expect(fetchDex).toHaveBeenCalledTimes(2)
    expect(l.stepsFor('e1')).toBe(8)
    expect(heard).toHaveBeenCalled()
    expect(END_DELAY_MS).toBe(1500)
  })

  it('a uid swap between the reads gives null', async () => {
    const l = createStepLedger({ fetchDex: fakeFetch([dex(10), dex(18, 'u2')]), now })
    l.onWorking('s-1'); await settle(100)
    l.onTurnEnd('s-1', 'e1', idle); await settle(END_DELAY_MS)
    expect(l.stepsFor('e1')).toBeNull()
  })

  it('two turns under one working period (a queued prompt) give null for the second', async () => {
    const fetchDex = fakeFetch([dex(10), dex(18), dex(30)])
    const l = createStepLedger({ fetchDex, now })
    l.onWorking('s-1'); await settle(100)
    l.onTurnEnd('s-1', 'e1', idle); await settle(END_DELAY_MS)
    expect(l.stepsFor('e1')).toBe(8)
    // the second turn ran with no new start (the status never went idle → working)
    l.onTurnEnd('s-1', 'e2', idle); await settle(END_DELAY_MS)
    expect(l.stepsFor('e2')).toBeNull()
    expect(fetchDex).toHaveBeenCalledTimes(2)
  })

  it('…and when the queued turn keeps the session working, the first is null too (its end read would be inside the next turn)', async () => {
    const fetchDex = fakeFetch([dex(10), dex(18)])
    const l = createStepLedger({ fetchDex, now })
    l.onWorking('s-1'); await settle(100)
    l.onTurnEnd('s-1', 'e1', working); await settle(END_DELAY_MS)
    l.onTurnEnd('s-1', 'e2', idle); await settle(END_DELAY_MS)
    expect(l.stepsFor('e1')).toBeNull()
    expect(l.stepsFor('e2')).toBeNull()
  })

  it('an end sample taken while working again gives null, and no read is made', async () => {
    const fetchDex = fakeFetch([dex(10), dex(18)])
    const l = createStepLedger({ fetchDex, now })
    l.onWorking('s-1'); await settle(100)
    l.onTurnEnd('s-1', 'e1', working); await settle(END_DELAY_MS)
    expect(l.stepsFor('e1')).toBeNull()
    expect(fetchDex).toHaveBeenCalledTimes(1)
    // waiting on the user is working too
    const l2 = createStepLedger({ fetchDex: fakeFetch([dex(10), dex(18)]), now })
    l2.onWorking('s-1'); await settle(100)
    l2.onTurnEnd('s-1', 'e1', () => 'waiting'); await settle(END_DELAY_MS)
    expect(l2.stepsFor('e1')).toBeNull()
  })

  it('a fetch error gives null (at the start or at the end)', async () => {
    const a = createStepLedger({ fetchDex: fakeFetch([new Error('down'), dex(18)]), now })
    a.onWorking('s-1'); await settle(100)
    a.onTurnEnd('s-1', 'e1', idle); await settle(END_DELAY_MS)
    expect(a.stepsFor('e1')).toBeNull()
    const b = createStepLedger({ fetchDex: fakeFetch([dex(10), new Error('down')]), now })
    b.onWorking('s-1'); await settle(100)
    b.onTurnEnd('s-1', 'e1', idle); await settle(END_DELAY_MS)
    expect(b.stepsFor('e1')).toBeNull()
    // a fetch that throws at once
    const c = createStepLedger({ fetchDex: () => { throw new Error('no') }, now })
    expect(() => c.onWorking('s-1')).not.toThrow()
    await settle(100)
    c.onTurnEnd('s-1', 'e1', idle); await settle(END_DELAY_MS)
    expect(c.stepsFor('e1')).toBeNull()
  })

  it('a turn end before the start read came back gives null (the start is spent)', async () => {
    let answer!: (v: unknown) => void
    const fetchDex = vi.fn().mockImplementationOnce(() => new Promise(r => { answer = r })).mockResolvedValue(dex(18))
    const l = createStepLedger({ fetchDex, now })
    l.onWorking('s-1')
    l.onTurnEnd('s-1', 'e1', idle)
    answer(dex(10))
    await settle(END_DELAY_MS)
    expect(l.stepsFor('e1')).toBeNull()
    l.onTurnEnd('s-1', 'e2', idle); await settle(END_DELAY_MS)
    expect(l.stepsFor('e2')).toBeNull()
  })

  it('another turn end or a new start of the session during the wait voids the end read', async () => {
    const a = createStepLedger({ fetchDex: fakeFetch([dex(10), dex(18), dex(20)]), now })
    a.onWorking('s-1'); await settle(100)
    a.onTurnEnd('s-1', 'e1', idle); await settle(500)
    a.onTurnEnd('s-1', 'e2', idle); await settle(END_DELAY_MS)
    expect(a.stepsFor('e1')).toBeNull()
    expect(a.stepsFor('e2')).toBeNull()
    const b = createStepLedger({ fetchDex: fakeFetch([dex(10), dex(12), dex(18)]), now })
    b.onWorking('s-1'); await settle(100)
    b.onTurnEnd('s-1', 'e1', idle); await settle(500)
    b.onWorking('s-1'); await settle(END_DELAY_MS)
    expect(b.stepsFor('e1')).toBeNull()
  })

  it('another session\'s start or end changes nothing here', async () => {
    const fetchDex = fakeFetch([dex(10), dex(4, 'u9', 's-2'), dex(18)])
    const l = createStepLedger({ fetchDex, now })
    l.onWorking('s-1'); await settle(100)
    l.onWorking('s-2'); await settle(100)
    l.onTurnEnd('s-1', 'e1', idle); await settle(END_DELAY_MS)
    expect(l.stepsFor('e1')).toBe(8)
  })

  it('an end read before its start (the clock went back) or fewer steps than at the start gives null', async () => {
    const a = createStepLedger({ fetchDex: fakeFetch([dex(10), dex(18)]), now })
    a.onWorking('s-1'); await settle(100)
    clock -= 3_600_000
    a.onTurnEnd('s-1', 'e1', idle); await settle(END_DELAY_MS)
    expect(a.stepsFor('e1')).toBeNull()
    const b = createStepLedger({ fetchDex: fakeFetch([dex(10), dex(7)]), now })
    b.onWorking('s-1'); await settle(100)
    b.onTurnEnd('s-1', 'e1', idle); await settle(END_DELAY_MS)
    expect(b.stepsFor('e1')).toBeNull()
  })

  it('a turn end with no start seen (the view opened while it worked) gives null and reads nothing', async () => {
    const fetchDex = fakeFetch([dex(18)])
    const l = createStepLedger({ fetchDex, now })
    l.onTurnEnd('s-1', 'e1', idle); await settle(END_DELAY_MS)
    expect(l.stepsFor('e1')).toBeNull()
    expect(fetchDex).not.toHaveBeenCalled()
  })
})

describe('memory', () => {
  it(`at most ${RESULTS_PER_SESSION} results per session; stop drops what is pending, forget drops all`, async () => {
    let n = 0
    const l = createStepLedger({ fetchDex: () => Promise.resolve(dex(n++ % 2 ? 1000 + n : n)), now })
    for (let i = 0; i < RESULTS_PER_SESSION + 5; i++) {
      l.onWorking('s-1'); await settle(10)
      l.onTurnEnd('s-1', `e${i}`, idle); await settle(END_DELAY_MS)
    }
    expect(l.stepsFor('e0')).toBeNull()
    expect(l.stepsFor(`e${RESULTS_PER_SESSION + 4}`)).not.toBeNull()
    expect(l.size('s-1')).toBe(RESULTS_PER_SESSION)
    // stop: the pending end read is dropped, the results kept
    l.onWorking('s-1'); await settle(10)
    l.onTurnEnd('s-1', 'late', idle)
    l.stop('s-1')
    await settle(END_DELAY_MS)
    expect(l.stepsFor('late')).toBeNull()
    expect(l.size('s-1')).toBe(RESULTS_PER_SESSION)
    l.forget('s-1')
    expect(l.size('s-1')).toBe(0)
    expect(l.stepsFor(`e${RESULTS_PER_SESSION + 4}`)).toBeNull()
  })
})

describe('업무 모드 and off: no ledger, no read', () => {
  it('stepLedgerFor(false) makes nothing and reads nothing; the default read is GET /pokedex with nothing of the user', async () => {
    const fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(dex(10)) }))
    vi.stubGlobal('fetch', fetch)
    expect(stepLedgerFor(false)).toBeNull()
    await settle(END_DELAY_MS * 2)
    expect(fetch).not.toHaveBeenCalled()
    const l = stepLedgerFor(true)!
    expect(l).toBeTruthy()
    expect(stepLedgerFor(true)).toBe(l)
    l.onWorking('s-1')
    await settle(10)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/pokedex$/)
    expect(url).not.toMatch(/[?#]/)
    expect(init).toEqual({ credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
    l.forget('s-1')
  })

  it('the source: one GET of /pokedex, no header, no token, no body; the view makes the ledger only outside 업무 모드', () => {
    const steps = code(readFileSync(join(ROOT, 'src', 'chat', 'steps.ts'), 'utf8'))
    expect(steps.match(/fetch\(/g)).toHaveLength(1)
    expect(steps).toMatch(/fetch\(`\$\{serverHttpBase\(\)\}\/pokedex`, \{ credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' \}\)/)
    expect(steps).not.toMatch(/headers|token|Authorization|method:|body:/i)
    expect(steps).toMatch(/onChatForget\(/)
    const view = code(readFileSync(join(ROOT, 'src', 'components', 'ChatView.tsx'), 'utf8'))
    expect(view).toMatch(/const game = !workMode && !fixed/)
    expect(view).toMatch(/stepLedgerFor\(game\)/)
    expect(view.match(/stepLedgerFor\(/g)).toHaveLength(1)
    // the view hands the foot the steps only outside 업무 모드
    expect(view).toMatch(/\.\.\.\(ledger \? \{ stepsFor: ledger\.stepsFor, stepsSubscribe: ledger\.subscribe \} : \{\}\)/)
    // the foot's steps span is behind the work-mode guard
    const foot = code(readFileSync(join(ROOT, 'src', 'components', 'chat', 'TurnFoot.tsx'), 'utf8'))
    expect(foot).toMatch(/\{!workMode && steps !== null && \(/)
  })
})

describe('the store tells a live turn end from history', () => {
  const st = (over: Partial<LensStatus> = {}): LensStatus => ({ state: 'idle', since: null, label: null, banner: null, note: null, version: null, hasOlder: false, empty: false, ...over })
  const end = (id: string, order: number): ChatItem => ({ id, order, at: null, kind: 'turn-end', durationMs: 1000 })
  const text = (id: string, order: number): ChatItem => ({ id, order, at: null, kind: 'text', text: id })

  function store() {
    let listener: ((u: ChatUpdate) => void) | null = null
    const bridge = { open: () => Promise.resolve({ ok: true }), close() {}, resync: () => Promise.resolve({ ok: true }), onUpdate: (fn: (u: ChatUpdate) => void) => { listener = fn; return () => {} } }
    const s = createChatStore(bridge as never)
    s.subscribe('t1', () => {})
    return { s, send: (u: ChatUpdate) => listener!(u) }
  }

  it('a reset\'s turn ends are history; an upsert past the end is live; an older page is history', () => {
    const { s, send } = store()
    const heard: string[] = []
    const off = s.onAppended((id, items) => { for (const i of items) heard.push(`${id}:${i.id}`) })
    send({ id: 't1', rev: 1, ops: [{ op: 'reset', items: [text('a', 10), end('e1', 20)], status: st() }] })
    expect(heard).toEqual([])
    send({ id: 't1', rev: 2, ops: [{ op: 'upsert', items: [text('b', 30), end('e2', 40)] }] })
    expect(heard).toEqual(['t1:b', 't1:e2'])
    // an older page (orders below what is held), and an item replaced in place: not appended
    send({ id: 't1', rev: 3, ops: [{ op: 'upsert', items: [end('e0', 5), text('b', 30)] }] })
    expect(heard).toEqual(['t1:b', 't1:e2'])
    // a resync / 다시 읽기 brings the same and more as a reset: history
    send({ id: 't1', rev: 9, ops: [{ op: 'reset', items: [text('a', 10), end('e1', 20), end('e3', 50)], status: st() }] })
    expect(heard).toEqual(['t1:b', 't1:e2'])
    // a gap: nothing applied, nothing heard
    send({ id: 't1', rev: 12, ops: [{ op: 'upsert', items: [end('e4', 60)] }] })
    expect(heard).toEqual(['t1:b', 't1:e2'])
    off()
    send({ id: 't1', rev: 10, ops: [{ op: 'upsert', items: [end('e5', 70)] }] })
    expect(heard).toEqual(['t1:b', 't1:e2'])
  })

  it('the first turn of a new session (an empty reset, then upserts) is live', () => {
    const { s, send } = store()
    const heard: string[] = []
    s.onAppended((_id, items) => { for (const i of items) heard.push(i.id) })
    send({ id: 't1', rev: 1, ops: [{ op: 'reset', items: [], status: st({ empty: true }) }] })
    send({ id: 't1', rev: 2, ops: [{ op: 'upsert', items: [end('e1', 20)] }] })
    expect(heard).toEqual(['e1'])
  })
})
