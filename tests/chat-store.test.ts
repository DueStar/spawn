/**
 * src/chat/store.ts — the page's copy of a conversation: updates applied in rev
 * order (a gap asks for a fresh read), items kept sorted by (order, id), an
 * upsert replacing an item whole, and at most `cap` items kept.
 */

import { describe, expect, it, vi } from 'vitest'
import { applyUpdate, createChatStore, EMPTY_CHAT, type ChatState } from '../src/chat/store'
import type { ChatItem, ChatUpdate, LensStatus } from '../src/chat/types'
import { LIVE_ORDER } from '../src/chat/types'

const STATUS: LensStatus = { state: 'idle', since: null, label: null, banner: null, note: null, version: '2.1.323', hasOlder: false, empty: false }
const text = (id: string, order: number, t = id): ChatItem => ({ id, order, at: null, kind: 'text', text: t })
const user = (id: string, order: number): ChatItem => ({ id, order, at: null, kind: 'user', text: id, images: 0 })
const upd = (rev: number, ops: ChatUpdate['ops']): ChatUpdate => ({ id: 't1', rev, ops })
const ids = (s: ChatState) => s.items.map(i => i.id)

function run(...updates: ChatUpdate[]): ChatState {
  let s = EMPTY_CHAT
  for (const u of updates) {
    const r = applyUpdate(s, u)
    expect(r.gap).toBe(false)
    s = r.state
  }
  return s
}

describe('applyUpdate', () => {
  it('reset, then upsert, then remove, in order', () => {
    const s = run(
      upd(1, [{ op: 'reset', items: [user('u1', 0), text('a', 10)], status: STATUS }]),
      upd(2, [{ op: 'upsert', items: [text('b', 20)] }]),
      upd(3, [{ op: 'remove', ids: ['a'] }]),
    )
    expect(ids(s)).toEqual(['u1', 'b'])
    expect(s.rev).toBe(3)
    expect(s.status).toEqual(STATUS)
  })

  it('a reset sorts what it is given; an upsert out of order goes to its place', () => {
    const s = run(
      upd(1, [{ op: 'reset', items: [text('c', 30), text('a', 10)], status: STATUS }]),
      upd(2, [{ op: 'upsert', items: [text('b', 20), text('d', 40), text('a0', 5)] }]),
    )
    expect(ids(s)).toEqual(['a0', 'a', 'b', 'c', 'd'])
  })

  it('equal orders sort by id', () => {
    const s = run(upd(1, [{ op: 'reset', items: [text('y', 10), text('x', 10)], status: STATUS }]))
    expect(ids(s)).toEqual(['x', 'y'])
  })

  it('an upsert of an existing id replaces it whole and moves it to its new order (a hook row placed by its transcript line)', () => {
    const s = run(
      upd(1, [{ op: 'reset', items: [text('a', 10), { id: 'tool1', order: 2 ** 52, at: null, kind: 'tool', tool: 'Read', input: {}, state: 'running', waiting: 'permission' }, text('c', 30)], status: STATUS }]),
      upd(2, [{ op: 'upsert', items: [{ id: 'tool1', order: 20, at: null, kind: 'tool', tool: 'Read', input: { file: 'a.ts' }, state: 'done' }] }]),
    )
    expect(ids(s)).toEqual(['a', 'tool1', 'c'])
    const tool = s.items[1] as any
    expect(tool.state).toBe('done')
    expect(tool.waiting).toBeUndefined()
    expect(tool.input).toEqual({ file: 'a.ts' })
  })

  it('a gap leaves the state alone and says so; a reset is applied whatever its rev', () => {
    const s = run(upd(1, [{ op: 'reset', items: [text('a', 10)], status: STATUS }]))
    const gap = applyUpdate(s, upd(3, [{ op: 'upsert', items: [text('b', 20)] }]))
    expect(gap.gap).toBe(true)
    expect(gap.state).toBe(s)
    const reset = applyUpdate(s, upd(9, [{ op: 'reset', items: [text('z', 1)], status: STATUS }]))
    expect(reset.gap).toBe(false)
    expect(ids(reset.state)).toEqual(['z'])
    expect(reset.state.rev).toBe(9)
  })

  it('an update already applied (an old rev) changes nothing and is no gap', () => {
    const s = run(
      upd(1, [{ op: 'reset', items: [text('a', 10)], status: STATUS }]),
      upd(2, [{ op: 'upsert', items: [text('b', 20)] }]),
    )
    const again = applyUpdate(s, upd(2, [{ op: 'upsert', items: [text('c', 30)] }]))
    expect(again.gap).toBe(false)
    expect(again.state).toBe(s)
  })

  it('the provisional bubble replaced by its text in one update leaves one row', () => {
    const s = run(
      upd(1, [{ op: 'reset', items: [user('u', 0)], status: STATUS }]),
      upd(2, [{ op: 'upsert', items: [{ id: 'live:m1', order: LIVE_ORDER, at: null, kind: 'live', text: 'Hel' }] }]),
      upd(3, [{ op: 'remove', ids: ['live:m1'] }, { op: 'upsert', items: [text('t1', 100, 'Hello')] }]),
    )
    expect(ids(s)).toEqual(['u', 't1'])
  })

  it('a status op replaces the status', () => {
    const s = run(
      upd(1, [{ op: 'reset', items: [], status: STATUS }]),
      upd(2, [{ op: 'status', status: { ...STATUS, state: 'working', since: 5 } }]),
    )
    expect(s.status?.state).toBe('working')
    expect(s.status?.since).toBe(5)
  })

  it('over the cap the oldest items go and hasOlder is set (cap 5 over 8 items)', () => {
    const items = Array.from({ length: 8 }, (_, i) => text(`i${i}`, i * 10))
    const r = applyUpdate(EMPTY_CHAT, upd(1, [{ op: 'reset', items, status: STATUS }]), 5)
    expect(ids(r.state)).toEqual(['i3', 'i4', 'i5', 'i6', 'i7'])
    expect(r.state.status?.hasOlder).toBe(true)
    expect(STATUS.hasOlder).toBe(false) // the status given is not changed in place
  })

  it('the cap drops a sub-agent\'s items with their Agent row, not first because of their own file\'s offsets', () => {
    const agent: ChatItem = { id: 'ag', order: 25, at: null, kind: 'tool', tool: 'Agent', input: {}, state: 'done' }
    const child = (id: string, order: number): ChatItem => ({ id, order, at: null, kind: 'tool', tool: 'Read', input: {}, state: 'done', parent: 'ag' })
    const r = applyUpdate(EMPTY_CHAT, upd(1, [{ op: 'reset', items: [text('a', 10), text('b', 20), agent, child('c1', 1), child('c2', 2), text('z', 30)], status: STATUS }]), 5)
    // one item over: the oldest main item goes; the children (orders 1, 2) stay with their row
    expect(ids(r.state).sort()).toEqual(['ag', 'b', 'c1', 'c2', 'z'])
    const r2 = applyUpdate(EMPTY_CHAT, upd(1, [{ op: 'reset', items: [agent, child('c1', 1), child('c2', 2), text('y', 28), text('z', 30)], status: STATUS }]), 3)
    // the Agent row is the oldest main item: it goes, and its children with it
    expect(ids(r2.state)).toEqual(['y', 'z'])
  })

  it('does not change the state it was given', () => {
    const s = run(upd(1, [{ op: 'reset', items: [text('a', 10)], status: STATUS }]))
    const before = JSON.stringify(s)
    applyUpdate(s, upd(2, [{ op: 'upsert', items: [text('b', 5)] }, { op: 'remove', ids: ['a'] }]))
    expect(JSON.stringify(s)).toBe(before)
  })

  it('ignores items of a kind it does not know only at render time: they are kept and sorted like the rest', () => {
    const odd = { id: 'q', order: 15, at: null, kind: 'hologram' } as unknown as ChatItem
    const s = run(upd(1, [{ op: 'reset', items: [text('a', 10), odd, text('b', 20)], status: STATUS }]))
    expect(ids(s)).toEqual(['a', 'q', 'b'])
  })
})

describe('createChatStore (the bridge glue behind useChat)', () => {
  function fakeBridge() {
    let listener: ((u: ChatUpdate) => void) | null = null
    const b = {
      open: vi.fn(async () => ({ ok: true as const })),
      close: vi.fn(),
      older: vi.fn(async () => ({ ok: true, loaded: 0 })),
      reload: vi.fn(async () => ({ ok: true })),
      resync: vi.fn(async () => ({ ok: true })),
      agent: vi.fn(async () => ({ ok: true })),
      onUpdate: vi.fn((fn: (u: ChatUpdate) => void) => { listener = fn; return () => { listener = null } }),
    }
    return { b, push: (u: ChatUpdate) => listener?.(u) }
  }

  it('opens on the first subscriber, closes when the last leaves, one listener for the page', () => {
    const { b } = fakeBridge()
    const store = createChatStore(b)
    const off1 = store.subscribe('t1', () => {})
    const off2 = store.subscribe('t1', () => {})
    expect(b.open).toHaveBeenCalledTimes(1)
    expect(b.open).toHaveBeenCalledWith('t1')
    off1()
    expect(b.close).not.toHaveBeenCalled()
    off2()
    expect(b.close).toHaveBeenCalledWith('t1')
    store.subscribe('t2', () => {})
    expect(b.onUpdate).toHaveBeenCalledTimes(1)
  })

  it('applies updates for its terminal and tells the subscribers; a gap asks for a resync once (never a reload)', () => {
    const { b, push } = fakeBridge()
    const store = createChatStore(b)
    const seen = vi.fn()
    store.subscribe('t1', seen)
    push({ id: 't1', rev: 1, ops: [{ op: 'reset', items: [text('a', 1)], status: STATUS }] })
    expect(ids(store.get('t1'))).toEqual(['a'])
    expect(seen).toHaveBeenCalledTimes(1)
    push({ id: 't1', rev: 5, ops: [{ op: 'upsert', items: [text('b', 2)] }] })
    push({ id: 't1', rev: 6, ops: [{ op: 'upsert', items: [text('c', 3)] }] })
    expect(b.resync).toHaveBeenCalledTimes(1)
    expect(b.reload).not.toHaveBeenCalled()
    expect(ids(store.get('t1'))).toEqual(['a'])
    push({ id: 't1', rev: 7, ops: [{ op: 'reset', items: [text('z', 1)], status: STATUS }] })
    expect(ids(store.get('t1'))).toEqual(['z'])
    push({ id: 't1', rev: 9, ops: [{ op: 'upsert', items: [text('y', 2)] }] })
    expect(b.resync).toHaveBeenCalledTimes(2)
    expect(b.reload).not.toHaveBeenCalled()
  })

  // review I5 / M21: main numbers every terminal's updates, also the status-only ones of views not open
  it('the revs of a terminal are followed before it is opened, so its first update after opening is no gap', () => {
    const { b, push } = fakeBridge()
    const store = createChatStore(b)
    push({ id: 't1', rev: 1, ops: [{ op: 'status', status: STATUS }] })
    push({ id: 't1', rev: 2, ops: [{ op: 'status', status: { ...STATUS, state: 'working' } }] })
    const seen = vi.fn()
    store.subscribe('t1', seen)
    push({ id: 't1', rev: 3, ops: [{ op: 'status', status: { ...STATUS, state: 'waiting' } }] })
    expect(b.resync).not.toHaveBeenCalled()
    expect(store.get('t1').status?.state).toBe('waiting')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('a status before any reset is taken (the worker gone for good answers open with a status only)', () => {
    const { b, push } = fakeBridge()
    const store = createChatStore(b)
    store.subscribe('t1', () => {})
    push({ id: 't1', rev: 1, ops: [{ op: 'status', status: { ...STATUS, banner: { reason: 'worker' } } }] })
    expect(store.get('t1').status?.banner).toEqual({ reason: 'worker' })
    expect(b.resync).not.toHaveBeenCalled()
  })

  it('a closed conversation kept in memory asks for nothing on a gap (its next open sends a reset)', () => {
    const { b, push } = fakeBridge()
    const store = createChatStore(b)
    const off = store.subscribe('t1', () => {})
    push({ id: 't1', rev: 1, ops: [{ op: 'reset', items: [text('a', 1)], status: STATUS }] })
    off()
    push({ id: 't1', rev: 7, ops: [{ op: 'status', status: STATUS }] })
    expect(b.resync).not.toHaveBeenCalled()
    expect(b.reload).not.toHaveBeenCalled()
  })

  it('another terminal\'s updates do not touch this one', () => {
    const { b, push } = fakeBridge()
    const store = createChatStore(b)
    store.subscribe('t1', () => {})
    push({ id: 't1', rev: 1, ops: [{ op: 'reset', items: [text('a', 1)], status: STATUS }] })
    push({ id: 't2', rev: 1, ops: [{ op: 'reset', items: [text('b', 1)], status: STATUS }] })
    expect(ids(store.get('t1'))).toEqual(['a'])
    expect(store.get('nobody')).toBe(EMPTY_CHAT)
  })

  it('with no bridge (a plain browser) nothing is opened and the state stays empty', () => {
    const store = createChatStore(null)
    const off = store.subscribe('t1', () => {})
    expect(store.get('t1')).toBe(EMPTY_CHAT)
    off()
  })
})
