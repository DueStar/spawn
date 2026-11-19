/**
 * electron/chatHolds.cjs — the held hooks of the chat's buttons: one response
 * per request, ever; "no decision" on every doubt; the answer bodies; the bounds.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const holdsMod = require('../electron/chatHolds.cjs')
const { HOLD, createHolds, permissionBody, questionBody, entryTimeoutS, DENY_MESSAGE } = holdsMod

const DIR = join(__dirname, 'fixtures', 'chat')
const answerFixture = (name: string) => JSON.parse(readFileSync(join(DIR, 'answers', name), 'utf8'))
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** A fake clock: timers fire in order as it advances */
function fakeTimers() {
  let now = 0
  let seq = 0
  const queue = new Map<number, { at: number; f: () => void }>()
  return {
    timers: {
      setTimeout(f: () => void, ms: number) { const id = ++seq; queue.set(id, { at: now + ms, f }); return id },
      clearTimeout(id: unknown) { queue.delete(id as number) },
    },
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        let next: [number, { at: number; f: () => void }] | null = null
        for (const e of queue) if (e[1].at <= end && (!next || e[1].at < next[1].at || (e[1].at === next[1].at && e[0] < next[0]))) next = e
        if (!next) break
        queue.delete(next[0])
        now = next[1].at
        next[1].f()
      }
      now = end
    },
    pending: () => queue.size,
  }
}

function setup(limits = HOLD) {
  const clock = fakeTimers()
  const changes: any[] = []
  let n = 0
  const holds = createHolds({ timers: clock.timers, limits, onChange: (e: any) => changes.push(e), newId: () => `hold${String(++n).padStart(4, '0')}` })
  return { clock, changes, holds }
}

const RULES = [{ toolName: 'Bash', ruleContent: 'node -e "console.log(6*7)"' }]
const Q1 = { question: 'Should README.md be updated too?', header: 'README', options: [{ label: 'Yes', description: 'Update the references to notes.txt.' }, { label: 'No', description: 'Only rename the file.' }], multiSelect: false }
const shown = (id: string) => ({ visibleId: id, windowVisible: true })

describe('the answer bodies', () => {
  it('allow, always (the session only, whatever the suggestion said), deny and a question are the fixtures', () => {
    expect(JSON.parse(permissionBody('allow'))).toEqual(answerFixture('allow.json'))
    expect(JSON.parse(permissionBody('always', RULES))).toEqual(answerFixture('always.json'))
    expect(JSON.parse(permissionBody('deny'))).toEqual(answerFixture('deny.json'))
    expect(JSON.parse(questionBody([Q1], 'No'))).toEqual(answerFixture('question.json'))
    expect(JSON.parse(permissionBody('deny')).hookSpecificOutput.decision.message).toBe(DENY_MESSAGE)
  })

  it('always never carries a destination but "session", nor a rule that is not a plain string pair', () => {
    const body = permissionBody('always', [{ toolName: 'Bash', ruleContent: 'x', destination: 'localSettings' }])
    expect(body).not.toMatch(/localSettings/)
    expect(JSON.parse(body).hookSpecificOutput.decision.updatedPermissions[0].destination).toBe('session')
    expect(permissionBody('always', [])).toBeNull()
    expect(permissionBody('always', [{ toolName: 3 }])).toBeNull()
    expect(permissionBody('always', Array(5).fill({ toolName: 'Bash' }))).toBeNull()
    expect(permissionBody('always', [{ toolName: 'Bash', ruleContent: 'x'.repeat(2001) }])).toBeNull()
    expect(permissionBody('maybe')).toBeNull()
    expect(questionBody([Q1, Q1], 'Yes')).toBeNull()
  })

  it('a question\'s answer keeps every field of the call\'s input (review M10)', () => {
    const input = { questions: [Q1], metadata: { source: 'x' } }
    const body = JSON.parse(questionBody(input, 'Yes'))
    expect(body.hookSpecificOutput.updatedInput).toEqual({ questions: [Q1], metadata: { source: 'x' }, answers: { [Q1.question]: 'Yes' } })
    // and through a hold bound with the whole input
    const sent: (string | null)[] = []
    const { holds } = setup()
    const id = holds.open('question', (b: string | null) => { sent.push(b) })
    holds.bind(id, { id: A, key: 'k', data: { questions: [Q1], labels: ['Yes', 'No'], input } })
    expect(holds.answer(id, { id: A, choice: 'option', option: 1, ...shown(A) })).toEqual({ ok: true })
    expect(JSON.parse(sent[0]!).hookSpecificOutput.updatedInput.metadata).toEqual({ source: 'x' })
  })

  it('an answer that could not be written (the client went that instant) is gone, never "sent" (review M6)', () => {
    const { holds, changes } = setup()
    const id = holds.open('permission', () => false)
    holds.bind(id, { id: A, key: 'k', data: { rules: [] } })
    expect(holds.answer(id, { id: A, choice: 'allow', ...shown(A) })).toEqual({ ok: false, reason: 'gone' })
    expect(changes.filter((c: any) => c.holdId === id).map((c: any) => c.state)).toEqual(['waiting-bind', 'open', 'gone'])
    // a respond that throws is not sent either
    const id2 = holds.open('permission', () => { throw new Error('EPIPE') })
    holds.bind(id2, { id: A, key: 'k', data: { rules: [] } })
    expect(holds.answer(id2, { id: A, choice: 'deny', ...shown(A) })).toEqual({ ok: false, reason: 'gone' })
    expect(holds.size()).toBe(0)
  })

  it('the entries outlast the holds: 330 s for 300 s', () => {
    expect(entryTimeoutS('permission')).toBe(330)
    expect(entryTimeoutS('question')).toBe(330)
    expect(entryTimeoutS('permission')).toBeGreaterThan(HOLD.permissionMs / 1000)
  })
})

describe('a hold', () => {
  it('open → bind → allow: one response with the allow body; nothing after it', () => {
    const { holds } = setup()
    const got: (string | null)[] = []
    const h = holds.open('permission', (b: string | null) => got.push(b), { id: A })
    expect(holds.bind(h, { id: A, key: 'k', data: { rules: RULES } })).toBe(true)
    expect(holds.answer(h, { id: A, choice: 'allow', ...shown(A) })).toEqual({ ok: true })
    expect(got).toHaveLength(1)
    expect(JSON.parse(got[0]!)).toEqual(answerFixture('allow.json'))
    expect(holds.release(h, 'late')).toBe(false)
    expect(holds.answer(h, { id: A, choice: 'deny', ...shown(A) })).toEqual({ ok: false, reason: 'gone' })
    expect(got).toHaveLength(1)
  })

  it('300 s with no answer: "no decision" once, then gone', () => {
    const { holds, clock, changes } = setup()
    const got: (string | null)[] = []
    const h = holds.open('permission', (b: string | null) => got.push(b), { id: A })
    holds.bind(h, { id: A, key: 'k', data: { rules: [] } })
    clock.advance(299_999)
    expect(got).toEqual([])
    clock.advance(1)
    expect(got).toEqual([null])
    expect(changes.at(-1)).toMatchObject({ holdId: h, state: 'released', why: 'timeout' })
    expect(holds.answer(h, { id: A, choice: 'allow', ...shown(A) })).toEqual({ ok: false, reason: 'gone' })
    clock.advance(1_000_000)
    expect(got).toEqual([null])
  })

  it('unbound for 2 s: released; passed: released at once', () => {
    const { holds, clock } = setup()
    const a: (string | null)[] = []
    const b: (string | null)[] = []
    holds.open('permission', (x: string | null) => a.push(x), { id: A })
    const hb = holds.open('question', (x: string | null) => b.push(x), { id: A })
    holds.pass(hb, 'plan')
    expect(b).toEqual([null])
    clock.advance(1999)
    expect(a).toEqual([])
    clock.advance(1)
    expect(a).toEqual([null])
  })

  it('refused answers send nothing: hidden, other session, always without rules, an option out of range, not bound', () => {
    const { holds } = setup()
    const got: (string | null)[] = []
    const p = holds.open('permission', (x: string | null) => got.push(x), { id: A })
    expect(holds.answer(p, { id: A, choice: 'allow', ...shown(A) })).toEqual({ ok: false, reason: 'not-bound' })
    holds.bind(p, { id: A, key: 'k', data: { rules: [] } })
    expect(holds.answer(p, { id: A, choice: 'allow', visibleId: B, windowVisible: true })).toEqual({ ok: false, reason: 'hidden' })
    expect(holds.answer(p, { id: A, choice: 'allow', visibleId: A, windowVisible: false })).toEqual({ ok: false, reason: 'hidden' })
    expect(holds.answer(p, { id: B, choice: 'allow', ...shown(B) })).toEqual({ ok: false, reason: 'other-session' })
    expect(holds.answer(p, { id: A, choice: 'always', ...shown(A) })).toEqual({ ok: false, reason: 'not-answerable' })
    expect(holds.answer(p, { id: A, choice: 'option', option: 0, ...shown(A) })).toEqual({ ok: false, reason: 'invalid' })
    const q = holds.open('question', (x: string | null) => got.push(x), { id: A })
    holds.bind(q, { id: A, key: 'q', data: { questions: [Q1], labels: ['Yes', 'No'] } })
    expect(holds.answer(q, { id: A, choice: 'option', option: 2, ...shown(A) })).toEqual({ ok: false, reason: 'invalid' })
    expect(holds.answer(q, { id: A, choice: 'allow', ...shown(A) })).toEqual({ ok: false, reason: 'invalid' })
    expect(got).toEqual([])
    expect(holds.answer(q, { id: A, choice: 'option', option: 1, ...shown(A) })).toEqual({ ok: true })
    expect(JSON.parse(got[0]!)).toEqual(answerFixture('question.json'))
  })

  it('a bind for another terminal than the URL named, or a question of another shape: released, not bound', () => {
    const { holds } = setup()
    const got: (string | null)[] = []
    const h = holds.open('permission', (x: string | null) => got.push(x), { id: A })
    expect(holds.bind(h, { id: B, key: 'k', data: { rules: [] } })).toBe(false)
    expect(got).toEqual([null])
    const q = holds.open('question', (x: string | null) => got.push(x), { id: A })
    expect(holds.bind(q, { id: A, key: 'q', data: { questions: [Q1], labels: ['only one'] } })).toBe(false)
    expect(got).toEqual([null, null])
  })

  it('16 at most; close() releases each once and refuses new ones; gone: no response', () => {
    const { holds } = setup()
    const got: (string | null)[][] = []
    for (let i = 0; i < 16; i++) { const mine: (string | null)[] = []; got.push(mine); expect(holds.open('permission', (x: string | null) => mine.push(x), { id: A })).not.toBeNull() }
    expect(holds.open('permission', () => {}, { id: A })).toBeNull()
    const goneOne: (string | null)[] = []
    holds.gone(holds.openFor(A)[0].holdId)
    expect(holds.close()).toBe(15)
    expect(got.filter(g => g.length === 1 && g[0] === null)).toHaveLength(15)
    expect(got.filter(g => g.length === 0)).toHaveLength(1)
    expect(holds.open('permission', (x: string | null) => goneOne.push(x), { id: A })).toBeNull()
  })

  it('releaseWhere: only the holds it names', () => {
    const { holds } = setup()
    const got: Record<string, (string | null)[]> = { a: [], b: [] }
    const ha = holds.open('question', (x: string | null) => got.a.push(x), { id: A })
    const hb = holds.open('permission', (x: string | null) => got.b.push(x), { id: B })
    holds.bind(ha, { id: A, key: 'q', data: { questions: [Q1], labels: ['Yes', 'No'] } })
    holds.bind(hb, { id: B, key: 'k', data: { rules: [] } })
    expect(holds.releaseWhere((h: any) => h.kind === 'question', 'hidden')).toBe(1)
    expect(got).toEqual({ a: [null], b: [] })
    expect(holds.openFor(B).map((h: any) => h.holdId)).toEqual([hb])
  })
})

/** A small seeded random source (mulberry32) */
function rng(seed: number) {
  let a = seed >>> 0
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

describe('exactly once (property)', () => {
  it('2 000 random sequences: at most one response per request; a body only through an accepted answer; every hold ends', () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const r = rng(seed)
      const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]
      const { holds, clock } = setup()
      const responses = new Map<string, (string | null)[]>()
      const accepted = new Set<string>()
      const ids: string[] = []
      for (let step = 0; step < 40; step++) {
        const op = Math.floor(r() * 10)
        const known = ids.length ? pick(ids) : 'none'
        if (op === 0 || !ids.length) {
          const kind = r() < 0.5 ? 'permission' : 'question'
          const slot: (string | null)[] = []
          const h = holds.open(kind, (b: string | null) => slot.push(b), { id: pick([A, B]) })
          if (h) { ids.push(h); responses.set(h, slot) }
        } else if (op === 1) holds.bind(known, { id: pick([A, B]), key: 'k', data: r() < 0.5 ? { rules: r() < 0.5 ? RULES : [] } : { questions: [Q1], labels: ['Yes', 'No'] } })
        else if (op === 2) holds.pass(known, 'x')
        else if (op === 3 || op === 4) {
          const res = holds.answer(known, { id: pick([A, B]), choice: pick(['allow', 'always', 'deny', 'option', 'nope']), option: pick([0, 1, 2, -1, 0.5]), visibleId: pick([A, B, null]), windowVisible: r() < 0.8 })
          if (res.ok) { expect(accepted.has(known)).toBe(false); accepted.add(known) }
        } else if (op === 5) holds.release(known, 'x')
        else if (op === 6 && r() < 0.2) holds.releaseAll('x')
        else if (op === 7) holds.gone(known)
        else clock.advance(Math.floor(r() * 400_000))
      }
      clock.advance(10_000_000)
      expect(holds.size()).toBe(0)
      expect(clock.pending()).toBe(0)
      for (const [h, got] of responses) {
        expect(got.length, `seed ${seed}`).toBeLessThanOrEqual(1)
        if (got.length && got[0] !== null) expect(accepted.has(h), `seed ${seed}`).toBe(true)
        if (accepted.has(h)) expect(typeof got[0]).toBe('string')
      }
    }
  })
})

describe('chatHolds.cjs source', () => {
  it('names no settings file or scope other than the session, and updatedPermissions once', () => {
    const src = readFileSync(join(__dirname, '..', 'electron', 'chatHolds.cjs'), 'utf8')
    expect(src).not.toMatch(/localSettings|userSettings|projectSettings|settings\.json/)
    expect(src.match(/updatedPermissions/g)?.length).toBe(1)
  })
})

// several questions at once, and a multi-select one, answered from the chat
describe('several questions and a multi-select', () => {
  const { questionsBody, MULTI_JOIN } = holdsMod
  const Q2 = { question: 'Which areas?', header: 'Areas', options: [{ label: 'UI' }, { label: 'Server' }, { label: 'Docs' }], multiSelect: true }
  const input = { questions: [Q1, Q2] }
  const sets = [['Yes', 'No'], ['UI', 'Server', 'Docs']]

  it('the body maps each question to its label, a multi-select\'s joined', () => {
    const body = JSON.parse(questionsBody(input, [['No'], ['UI', 'Docs']]))
    expect(body.hookSpecificOutput.updatedInput).toEqual({ ...input, answers: { [Q1.question]: 'No', [Q2.question]: `UI${MULTI_JOIN}Docs` } })
    expect(body.hookSpecificOutput.permissionDecision).toBe('allow')
  })
  it('a body that does not fit: none', () => {
    expect(questionsBody(input, [['No']])).toBeNull()
    expect(questionsBody(input, [['No', 'Yes'], ['UI']])).toBeNull()
    expect(questionsBody(input, [[], ['UI']])).toBeNull()
    expect(questionsBody({ questions: [Q1, Q1] }, [['No'], ['Yes']])).toBeNull()
  })
  it('through a hold: picks by index, checked against each question', () => {
    const sent: (string | null)[] = []
    const { holds } = setup()
    const id = holds.open('question', (b: string | null) => { sent.push(b) })
    expect(holds.bind(id, { id: A, key: 'k', data: { sets, input } })).toBe(true)
    expect(holds.answer(id, { id: A, choice: 'option', option: 0, ...shown(A) })).toEqual({ ok: false, reason: 'invalid' })
    expect(holds.answer(id, { id: A, choice: 'options', picks: [[0, 1], [0]], ...shown(A) })).toEqual({ ok: false, reason: 'invalid' })
    expect(holds.answer(id, { id: A, choice: 'options', picks: [[0], [3]], ...shown(A) })).toEqual({ ok: false, reason: 'invalid' })
    expect(holds.answer(id, { id: A, choice: 'options', picks: [[1], [2, 0]], ...shown(A) })).toEqual({ ok: true })
    expect(JSON.parse(sent[0]!).hookSpecificOutput.updatedInput.answers).toEqual({ [Q1.question]: 'No', [Q2.question]: 'UI, Docs' })
  })
  it('a bind whose sets do not fit the questions is released', () => {
    const { holds } = setup()
    const id = holds.open('question', () => {})
    expect(holds.bind(id, { id: A, key: 'k', data: { sets: [['Yes', 'No']], input } })).toBe(false)
  })
})

// Claude Code's question dialog always ends with its "Other" row (Type something); the chat's 직접 입력
// sends that question's own words as its answer — alone in a single-select, after the picks in a multi-select (the
// 2.1.328 binary: a multi-select's answer is its picks, not "__other__", then the typed words)
describe('a question\'s own words (직접 입력)', () => {
  const Q2 = { question: 'Which areas?', header: 'Areas', options: [{ label: 'UI' }, { label: 'Server' }, { label: 'Docs' }], multiSelect: true }
  const open = (input: any, sets: string[][]) => {
    const sent: (string | null)[] = []
    const { holds } = setup()
    const id = holds.open('question', (b: string | null) => { sent.push(b) })
    expect(holds.bind(id, { id: A, key: 'k', data: { sets, input } })).toBe(true)
    return { holds, id, sent, answers: () => JSON.parse(sent[0]!).hookSpecificOutput.updatedInput.answers }
  }

  it('one single-select question: its words alone are the answer, trimmed; the input kept whole', () => {
    const input = { questions: [Q1], extra: 1 }
    const h = open(input, [['Yes', 'No']])
    expect(h.holds.answer(h.id, { id: A, choice: 'options', picks: [[]], other: ['  Only the docs folder  '], ...shown(A) })).toEqual({ ok: true })
    expect(h.answers()).toEqual({ [Q1.question]: 'Only the docs folder' })
    expect(JSON.parse(h.sent[0]!).hookSpecificOutput.updatedInput.extra).toBe(1)
  })

  it('a multi-select: the picks, then the words, joined as the dialog joins them', () => {
    const h = open({ questions: [Q1, Q2] }, [['Yes', 'No'], ['UI', 'Server', 'Docs']])
    expect(h.holds.answer(h.id, { id: A, choice: 'options', picks: [[1], [2, 0]], other: [null, 'the CLI'], ...shown(A) })).toEqual({ ok: true })
    expect(h.answers()).toEqual({ [Q1.question]: 'No', [Q2.question]: 'UI, Docs, the CLI' })
  })

  it('refused: a pick and words in a single-select, nothing at all, blank words alone, too long, a control character, a wrong length', () => {
    const h = open({ questions: [Q1, Q2] }, [['Yes', 'No'], ['UI', 'Server', 'Docs']])
    const bad = (picks: number[][], other: unknown) => expect(h.holds.answer(h.id, { id: A, choice: 'options', picks, other, ...shown(A) })).toEqual({ ok: false, reason: 'invalid' })
    bad([[0], [0]], ['also this', null])
    bad([[], [0]], [null, null])
    bad([[], [0]], ['   ', null])
    bad([[], [0]], ['x'.repeat(2001), null])
    bad([[], [0]], ['a\u0007b', null])
    bad([[], [0]], ['words'])
    bad([[], [0]], [7, null])
    expect(h.sent).toEqual([])
    // a line break is kept (the field is one line; a paste may hold one)
    expect(h.holds.answer(h.id, { id: A, choice: 'options', picks: [[], [1]], other: ['two\r\nlines', null], ...shown(A) })).toEqual({ ok: true })
    expect(h.answers()[Q1.question]).toBe('two\nlines')
  })
})
