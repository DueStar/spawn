import { describe, expect, it } from 'vitest'
import { bucketOf, dropSlot, slideOffsets, keepOrder, manualOrder, markUsed, moveTo, nextSince, readManual, readUsed, statusOrder, MANUAL_KEY, ORDER_CAP, USED_KEY, type OrderInput } from '../src/sessionOrder'

const rows = (...r: [string, string, boolean?][]): OrderInput[] => r.map(([id, mood, asking]) => ({ id, mood, asking }))
const times = (o: Record<string, number>) => new Map(Object.entries(o))

describe('the left panel by what each session does', () => {
  it('buckets: 확인 필요 (or a question on screen), working, resting, ended', () => {
    expect(rows(['a', 'needs-you'], ['b', 'idle', true], ['c', 'working'], ['d', 'idle'], ['e', 'error'], ['f', 'ended']).map(bucketOf)).toEqual([0, 0, 1, 2, 2, 3])
  })
  it('확인 필요 on top, then working, then resting, then ended', () => {
    expect(statusOrder(rows(['r', 'idle'], ['w', 'working'], ['x', 'ended'], ['n', 'needs-you']), times({}))).toEqual(['n', 'w', 'r', 'x'])
  })
  it('working keeps its order: one that starts joins the end', () => {
    const r = rows(['a', 'working'], ['b', 'working'], ['c', 'working'])
    expect(statusOrder(r, times({ a: 30, b: 10, c: 20 }))).toEqual(['b', 'c', 'a'])
  })
  it('resting: the one that came to rest last on top; 확인 필요: the newest on top', () => {
    expect(statusOrder(rows(['a', 'idle'], ['b', 'idle'], ['c', 'idle']), times({ a: 10, b: 30, c: 20 }))).toEqual(['b', 'c', 'a'])
    expect(statusOrder(rows(['a', 'needs-you'], ['b', 'needs-you']), times({ a: 10, b: 30 }))).toEqual(['b', 'a'])
  })
  it('the state each had when the app opened: the list\'s own order', () => {
    expect(statusOrder(rows(['a', 'idle'], ['b', 'working'], ['c', 'idle'], ['d', 'working']), times({}))).toEqual(['b', 'd', 'a', 'c'])
  })
  it('nextSince: first seen at 0, a new bucket at now, the same bucket keeps its time', () => {
    const first = nextSince(new Map(), rows(['a', 'idle'], ['b', 'working']), 100)
    expect([...first.values()].map(v => v.at)).toEqual([0, 0])
    const second = nextSince(first, rows(['a', 'working'], ['b', 'working']), 200)
    expect(second.get('a')).toEqual({ b: 1, at: 200 })
    expect(second.get('b')).toEqual({ b: 1, at: 0 })
    // a session opened since the app opened comes into its state now (a new working one joins the end)
    const third = nextSince(second, rows(['a', 'working'], ['b', 'idle'], ['c', 'working']), 300)
    expect(third.get('b')).toEqual({ b: 2, at: 300 })
    expect(third.get('c')).toEqual({ b: 1, at: 300 })
  })
})

describe('the session used last on top of its group', () => {
  it('inside each group the last used first; the groups stay stacked', () => {
    const r = rows(['a', 'idle'], ['b', 'idle'], ['w1', 'working'], ['w2', 'working'], ['n', 'needs-you'])
    expect(statusOrder(r, times({}), times({ a: 50, b: 90, w1: 10, w2: 40 }))).toEqual(['n', 'w2', 'w1', 'b', 'a'])
  })
  it('a used one before the unused; the unused keep the 1.7.0 rule', () => {
    // started a, then b, then c; only c used
    expect(statusOrder(rows(['a', 'working'], ['b', 'working'], ['c', 'working']), times({ a: 10, b: 20, c: 30 }), times({ c: 5 }))).toEqual(['c', 'a', 'b'])
    expect(statusOrder(rows(['x', 'idle'], ['y', 'idle']), times({ x: 10, y: 30 }), times({}))).toEqual(['y', 'x'])
  })
  it('Claude finishing a turn is not use: a newer rest does not pass the one used last', () => {
    expect(statusOrder(rows(['a', 'idle'], ['b', 'idle']), times({ a: 300 }), times({ a: 100, b: 200 }))).toEqual(['b', 'a'])
  })
  it('markUsed: the time set, the newest ORDER_CAP kept', () => {
    expect(markUsed(new Map([['a', 1]]), 'a', 9).get('a')).toBe(9)
    let m: ReadonlyMap<string, number> = new Map()
    for (let i = 0; i < ORDER_CAP + 5; i++) m = markUsed(m, `s${i}`, i)
    expect(m.size).toBe(ORDER_CAP)
    expect(m.has('s0')).toBe(false)
    expect(m.has(`s${ORDER_CAP + 4}`)).toBe(true)
  })
  it('readUsed / readManual: odd or missing values are nothing', () => {
    const store = (v: Record<string, string>) => ({ getItem: (k: string) => v[k] ?? null })
    expect([...readUsed(store({ [USED_KEY]: '{"a":5,"b":"x"}' }))]).toEqual([['a', 5]])
    expect(readUsed(store({ [USED_KEY]: '[1]' })).size).toBe(0)
    expect(readUsed(store({ [USED_KEY]: '{bad' })).size).toBe(0)
    expect(readUsed(null).size).toBe(0)
    expect(readManual(store({ [MANUAL_KEY]: '["a",3,"b"]' }))).toEqual(['a', 'b'])
    expect(readManual(store({}))).toBeNull()
    expect(readManual({ getItem: () => { throw new Error('blocked') } })).toBeNull()
  })
})

describe('직접 정렬: the order the user dragged', () => {
  it('the saved order; a session not in it goes on top', () => {
    expect(manualOrder(['a', 'b', 'c', 'n'], ['c', 'a', 'b'])).toEqual(['n', 'c', 'a', 'b'])
    // nothing saved yet: the list's own order (one who had 자동 정렬 off before keeps it)
    expect(manualOrder(['a', 'b'], null)).toEqual(['a', 'b'])
  })
  it('keepOrder: the shown order, then saved ids not open now (a session still reopening keeps its place)', () => {
    expect(keepOrder(['b', 'a'], ['x', 'a', 'b', 'y'])).toEqual(['b', 'a', 'x', 'y'])
    expect(manualOrder(['x', 'b', 'a'], keepOrder(['b', 'a'], ['a', 'x', 'b']))).toEqual(['b', 'a', 'x'])
    expect(keepOrder(Array.from({ length: 70 }, (_, i) => `s${i}`), null)).toHaveLength(ORDER_CAP)
  })
  it('switching 자동 → 직접 starts from the order on screen, so nothing moves', () => {
    const shownAuto = statusOrder(rows(['a', 'idle'], ['b', 'working'], ['c', 'needs-you']), times({}))
    expect(manualOrder(['a', 'b', 'c'], keepOrder(shownAuto, ['a', 'b', 'c']))).toEqual(shownAuto)
  })
  it('moveTo: before the row at the slot; where it already is, the same array', () => {
    const o = ['a', 'b', 'c', 'd']
    expect(moveTo(o, 'a', 3)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveTo(o, 'a', 4)).toEqual(['b', 'c', 'd', 'a'])
    expect(moveTo(o, 'd', 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveTo(o, 'c', 1)).toEqual(['a', 'c', 'b', 'd'])
    expect(moveTo(o, 'b', 1)).toBe(o)
    expect(moveTo(o, 'b', 2)).toBe(o)
    expect(moveTo(o, 'zz', 0)).toBe(o)
    // Alt+↑ on the first, Alt+↓ on the last: out of range, clamped, nothing moves
    expect(moveTo(o, 'a', -1)).toBe(o)
    expect(moveTo(o, 'd', 5)).toBe(o)
  })
  it('dropSlot: before the first row whose middle is below the pointer', () => {
    const mids = [10, 30, 50]
    expect(dropSlot(mids, 0)).toBe(0)
    expect(dropSlot(mids, 25)).toBe(1)
    expect(dropSlot(mids, 49)).toBe(2)
    expect(dropSlot(mids, 99)).toBe(3)
  })
})

describe('slideOffsets: the rows slide aside while one is dragged (no insertion line)', () => {
  // four rows 40 px tall, 4 px apart: tops 0, 44, 88, 132
  const boxes = [0, 44, 88, 132].map(top => ({ top, height: 40 }))
  it('over its own place (slot from or from + 1): nothing moves', () => {
    expect(slideOffsets(boxes, 1, 1)).toEqual([0, 0, 0, 0])
    expect(slideOffsets(boxes, 1, 2)).toEqual([0, 0, 0, 0])
  })
  it('dragged up to the top: the rows it passed step down by its height and the gap, it takes the first place', () => {
    expect(slideOffsets(boxes, 3, 0)).toEqual([44, 44, 44, -132])
  })
  it('dragged down to the end: the rows it passed step up, it takes the last place', () => {
    expect(slideOffsets(boxes, 0, 4)).toEqual([132, -44, -44, -44])
  })
  it('rows of different heights: the dragged row lands where the last row it passes ends', () => {
    const mixed = [{ top: 0, height: 60 }, { top: 64, height: 30 }, { top: 98, height: 30 }]
    expect(slideOffsets(mixed, 0, 3)).toEqual([68, -64, -64])
    expect(slideOffsets(mixed, 2, 0)).toEqual([34, 34, -98])
  })
  it('no rows or an unknown row: nothing moves', () => {
    expect(slideOffsets([], 0, 0)).toEqual([])
    expect(slideOffsets(boxes, -1, 0)).toEqual([0, 0, 0, 0])
  })
})

describe('slideOffsets with the pointer: the dragged row itself follows it, only the others slide', () => {
  const boxes = [0, 44, 88, 132].map(top => ({ top, height: 40 }))
  it('the dragged row is where the pointer took it, the rows it passed step aside', () => {
    expect(slideOffsets(boxes, 3, 0, -120)).toEqual([44, 44, 44, -120])
    expect(slideOffsets(boxes, 0, 4, 100)).toEqual([100, -44, -44, -44])
  })
  it('over its own place: only the dragged row moves, with the pointer', () => {
    expect(slideOffsets(boxes, 1, 1, 10)).toEqual([0, 10, 0, 0])
    expect(slideOffsets(boxes, 1, 2, -8)).toEqual([0, -8, 0, 0])
  })
})
