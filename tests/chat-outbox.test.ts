/**
 * src/chat/outbox.ts — the composer's provisional bubbles: one per message sent from this
 * page, replaced by the transcript's user line (or the queue strip, while Claude Code holds
 * it), and saying so when the record does not show it within 8 s. A bubble never lies and
 * never disappears without a reason.
 */

import { describe, expect, it } from 'vitest'
import { baselineOf, createOutbox, pendingItems, reconcile, sentMatches, type OutboxEntry } from '../src/chat/outbox'
import { LIVE_BASE, PENDING_BASE, type ChatItem, type LensStatus } from '../src/chat/types'

const STATUS: LensStatus = { state: 'idle', since: null, label: null, banner: null, note: null, version: null, hasOlder: false, empty: false }
const user = (id: string, order: number, text: string, images = 0): ChatItem => ({ id, order, at: 1, kind: 'user', text, images })
const entry = (o: Partial<OutboxEntry> = {}): OutboxEntry => ({ local: 'l1', text: 'Without tools, name three rivers', images: [], state: 'sent', at: 1000, sentAt: 1000, baseline: 500, ...o })
const PATH = 'C:\\Users\\user\\AppData\\Local\\Temp\\spawn-chat-0a1b2c3d\\11111111-1111-4111-8111-111111111111\\0123456789abcdef01234567.png'

describe('sentMatches', () => {
  it('the same text; image markers and the app\'s own temp paths aside; a leading space aside', () => {
    expect(sentMatches('hello there', 'hello there')).toBe(true)
    expect(sentMatches('hello  there\n', ' hello there')).toBe(true)
    expect(sentMatches('what is this? ' + PATH, 'what is this? [Image #1]')).toBe(true)
    expect(sentMatches('what is this?', `what is this? "${PATH.replace('Local', 'Lo cal')}"`)).toBe(true)
    expect(sentMatches('!ls', ' !ls')).toBe(true)
    expect(sentMatches('hello', 'hello there')).toBe(false)
  })
  it('long texts: one starts with the other\'s first 200 characters (20 at least)', () => {
    const long = 'x'.repeat(250)
    expect(sentMatches(long, long.slice(0, 220))).toBe(true)
    expect(sentMatches('short one', 'short one and more')).toBe(false)
    expect(sentMatches('', '')).toBe(true)
  })
})

describe('reconcile', () => {
  it('a sent entry matched by a user line after its baseline: dropped, with the item it became', () => {
    const r = reconcile([entry()], [user('u1', 400, 'Without tools, name three rivers'), user('u2', 900, 'Without tools, name three rivers')], STATUS, 2000)
    expect(r.entries).toEqual([])
    expect(r.matched).toEqual([{ local: 'l1', itemId: 'u2' }])
  })

  it('a user line before the baseline is an older message, not this one', () => {
    const r = reconcile([entry()], [user('u1', 400, 'Without tools, name three rivers')], STATUS, 2000)
    expect(r.entries).toHaveLength(1)
    expect(r.matched).toEqual([])
  })

  it('the record shows images as markers and the app\'s path as text: still the same message', () => {
    const r = reconcile([entry({ text: 'what is in this picture?', images: [{ token: 't', url: 'blob:x' }] })], [user('u3', 900, 'what is in this picture? [Image #1]', 1)], STATUS, 2000)
    expect(r.matched).toEqual([{ local: 'l1', itemId: 'u3' }])
  })

  it('held in Claude Code\'s queue (the strip shows it): dropped, no item yet', () => {
    const r = reconcile([entry({ text: 'Then list the js files.' })], [], { ...STATUS, queued: [{ text: 'Then list the js files.', truncated: false }], queuedCount: 1 }, 2000)
    expect(r.entries).toEqual([])
    expect(r.matched).toEqual([{ local: 'l1', itemId: null }])
  })

  it('sent and not in the record: it stays plain (no "not in the record yet", 2026-11-23) until the line comes', () => {
    let r = reconcile([entry()], [], STATUS, 1000 + 8000)
    expect(r.entries[0].state).toBe('sent')
    r = reconcile(r.entries, [], STATUS, 60_000)
    expect(r.entries).toHaveLength(1)
    // a late line still replaces it
    r = reconcile(r.entries, [user('u9', 900, 'Without tools, name three rivers')], STATUS, 61_000)
    expect(r.entries).toEqual([])
  })

  it('an entry still sending is left alone; one line matches one entry only; live rows are not the record', () => {
    const two = [entry({ local: 'a' }), entry({ local: 'b' })]
    const r = reconcile(two, [user('u2', 900, 'Without tools, name three rivers'), user('live', LIVE_BASE + 1, 'Without tools, name three rivers')], STATUS, 2000)
    expect(r.matched).toEqual([{ local: 'a', itemId: 'u2' }])
    expect(r.entries.map(e => e.local)).toEqual(['b'])
    expect(reconcile([entry({ state: 'sending' })], [user('u2', 900, 'Without tools, name three rivers')], STATUS, 2000).entries).toHaveLength(1)
  })
})

describe('the bubbles', () => {
  it('one user item per entry, after the record and before the live rows, with its state', () => {
    const items = pendingItems([entry({ state: 'sending', images: [{ token: 't', url: 'blob:x' }] }), entry({ local: 'l2', state: 'unconfirmed' })])
    expect(items.map(i => [i.id, i.order, i.pending, i.images, i.local])).toEqual([
      ['pending:l1', PENDING_BASE, 'sending', 1, 'l1'],
      ['pending:l2', PENDING_BASE + 1, 'unconfirmed', 0, 'l2'],
    ])
    expect(PENDING_BASE).toBeLessThan(LIVE_BASE)
    expect(PENDING_BASE).toBeGreaterThan(2 ** 40)
  })

  it('the baseline: the largest order of the record (hook rows aside)', () => {
    expect(baselineOf([user('a', 10, 'x'), user('b', 900, 'y'), user('c', LIVE_BASE + 4, 'z')])).toBe(900)
    expect(baselineOf([])).toBe(-1)
  })
})

describe('the outbox of a terminal', () => {
  it('thumbnails follow the message to its line; the queue keeps them until the line comes; removed entries free their pictures', () => {
    const revoked: string[] = []
    const o = createOutbox({ revoke: (u: string) => revoked.push(u) })
    o.add(entry({ local: 'a', state: 'sending', images: [{ token: 't1', url: 'blob:a' }] }))
    o.mark('a', 'sent', 1000)
    o.sync([user('u1', 900, 'Without tools, name three rivers', 1)], STATUS, 1500)
    expect(o.entries()).toEqual([])
    expect(o.thumbs('u1')).toEqual(['blob:a'])
    // a queued one: no bubble, its picture waits for its line
    o.add(entry({ local: 'b', text: 'Then list the js files.', state: 'sent', images: [{ token: 't2', url: 'blob:b' }] }))
    o.sync([], { ...STATUS, queued: [{ text: 'Then list the js files.', truncated: false }], queuedCount: 1 }, 1600)
    expect(o.entries()).toEqual([])
    o.sync([user('u2', 950, 'Then list the js files. [Image #1]', 1)], STATUS, 1700)
    expect(o.thumbs('u2')).toEqual(['blob:b'])
    // a send refused: the entry and its picture go
    o.add(entry({ local: 'c', state: 'sending', images: [{ token: 't3', url: 'blob:c' }] }))
    o.remove('c')
    expect(revoked).toEqual(['blob:c'])
    o.forget()
    expect(revoked.sort()).toEqual(['blob:a', 'blob:b', 'blob:c'])
    expect(o.thumbs('u1')).toEqual([])
  })

  it('at most 30 thumbnails kept: the oldest go', () => {
    const revoked: string[] = []
    const o = createOutbox({ revoke: (u: string) => revoked.push(u) })
    for (let i = 0; i < 32; i++) {
      o.add(entry({ local: `l${i}`, text: `message number ${i} with enough words`, images: [{ token: `t${i}`, url: `blob:${i}` }] }))
      o.sync([user(`u${i}`, 1000 + i, `message number ${i} with enough words`, 1)], STATUS, 2000)
    }
    expect(revoked).toEqual(['blob:0', 'blob:1'])
    expect(o.thumbs('u0')).toEqual([])
    expect(o.thumbs('u31')).toEqual(['blob:31'])
  })

  it('subscribers hear every change; dismiss drops a bubble', () => {
    const o = createOutbox({ revoke: () => {} })
    let n = 0
    const off = o.subscribe(() => n++)
    o.add(entry({ local: 'a', state: 'sending' }))
    o.mark('a', 'sent', 1000)
    o.sync([], STATUS, 9500)
    expect(o.entries()[0].state).toBe('sent')
    o.dismiss('a')
    expect(o.entries()).toEqual([])
    expect(n).toBe(3)
    off()
    o.add(entry({ local: 'b' }))
    expect(n).toBe(3)
  })
})
