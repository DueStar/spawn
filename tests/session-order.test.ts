import { describe, expect, it } from 'vitest'
import { bucketOf, nextSince, statusOrder, type OrderInput } from '../src/sessionOrder'

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
