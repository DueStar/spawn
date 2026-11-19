/**
 * The 변경 사항 panel's width and when the left panel folds for it (src/changesWidth.ts):
 * 260–560px (320 by default, 288 in a window under 1200 with nothing remembered), the
 * conversation never under 400px, the left panel folded to the rail while the three do not
 * fit (300 + 320 + 620 = 1240), and no panel at all in a window too narrow even
 * folded. Remembered in page storage, which may throw.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CH_DEFAULT, CH_KEY, CH_MAX, CH_MIN, CH_TIGHT, CONVO_FIT, CONVO_FLOOR, OPEN_KEY, RAIL_W,
  autoFold, canOpen, changesWidthFor, clampChangesWidth, readChangesWidth, readOpen, writeChangesWidth, writeOpen,
} from '../src/changesWidth'

const throwing = { getItem: () => { throw new Error('no storage') }, setItem: () => { throw new Error('no storage') }, removeItem: () => { throw new Error('no storage') } }

describe('the numbers', () => {
  it('are the plan\'s', () => {
    expect([CH_MIN, CH_MAX, CH_DEFAULT, CH_TIGHT]).toEqual([260, 560, 320, 288])
    expect([CONVO_FIT, CONVO_FLOOR, RAIL_W]).toEqual([620, 400, 56])
    expect(CH_KEY).toBe('spawn-changes-w')
    expect(OPEN_KEY).toBe('spawn-changes-open')
  })
})

describe('clampChangesWidth', () => {
  it('keeps 260–560', () => {
    expect(clampChangesWidth(100, 3000)).toBe(260)
    expect(clampChangesWidth(900, 3000)).toBe(560)
    expect(clampChangesWidth(333.4, 3000)).toBe(333)
  })
  it('leaves the conversation 400px, never going under 260', () => {
    expect(clampChangesWidth(500, 800)).toBe(400)
    expect(clampChangesWidth(500, 600)).toBe(260)
  })
})

describe('autoFold', () => {
  const at = (winW: number, over: Partial<Parameters<typeof autoFold>[0]> = {}) =>
    autoFold({ winW, sideW: 300, chW: 320, open: true, chat: true, userHidden: false, ...over })
  it('folds below 300 + 320 + 620 = 1240, not at it', () => {
    expect(at(1239)).toBe(true)
    expect(at(1240)).toBe(false)
    expect(at(1100)).toBe(true)
  })
  it('never when the chat is not shown, the panel is closed, or the user folded it already', () => {
    expect(at(1000, { chat: false })).toBe(false)
    expect(at(1000, { open: false })).toBe(false)
    expect(at(1000, { userHidden: true })).toBe(false)
  })
  it('follows the widths', () => {
    expect(at(1300, { sideW: 420 })).toBe(true)
    expect(at(1300, { chW: 260 })).toBe(false)
  })
})

describe('canOpen', () => {
  it('no panel when even folded the conversation would be under 400px', () => {
    expect(canOpen({ winW: 700 })).toBe(false)
    expect(canOpen({ winW: 560 })).toBe(false)
    expect(canOpen({ winW: 720 })).toBe(true)
    expect(canOpen({ winW: 1440 })).toBe(true)
  })
})

describe('changesWidthFor', () => {
  it('the remembered width, else 288 under 1200 and 320 from it', () => {
    expect(changesWidthFor(null, 1100)).toBe(288)
    expect(changesWidthFor(null, 1199)).toBe(288)
    expect(changesWidthFor(null, 1200)).toBe(320)
    expect(changesWidthFor(400, 1100)).toBe(400)
  })
})

describe('remembered', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads a width 260–560, else nothing', () => {
    const store = (v: string | null) => ({ getItem: () => v })
    expect(readChangesWidth(store('400'))).toBe(400)
    expect(readChangesWidth(store(null))).toBe(null)
    expect(readChangesWidth(store(''))).toBe(null)
    expect(readChangesWidth(store('9999'))).toBe(null)
    expect(readChangesWidth(store('abc'))).toBe(null)
    expect(readChangesWidth(throwing)).toBe(null)
    expect(readChangesWidth(null)).toBe(null)
  })

  it('reads open as a word, closed by default', () => {
    expect(readOpen({ getItem: () => '1' })).toBe(true)
    expect(readOpen({ getItem: () => '0' })).toBe(false)
    expect(readOpen({ getItem: () => null })).toBe(false)
    expect(readOpen(throwing)).toBe(false)
  })

  it('writes a number or a word, and never throws', () => {
    const map = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, String(v)) }, removeItem: (k: string) => { map.delete(k) } })
    writeChangesWidth(401.6)
    expect(map.get(CH_KEY)).toBe('402')
    writeChangesWidth(null)
    expect(map.has(CH_KEY)).toBe(false)
    writeOpen(true)
    expect(map.get(OPEN_KEY)).toBe('1')
    writeOpen(false)
    expect(map.get(OPEN_KEY)).toBe('0')
    vi.stubGlobal('localStorage', throwing)
    expect(() => { writeChangesWidth(300); writeChangesWidth(null); writeOpen(true) }).not.toThrow()
  })
})

describe('the Mac: the left panel at its 300px minimum', () => {
  it('at 960 wide the panel opens, the left panel folding to the rail for it; under 716 it cannot open at all', () => {
    expect(canOpen({ winW: 960 })).toBe(true)
    expect(autoFold({ winW: 960, sideW: 300, chW: CH_TIGHT, open: true, chat: true, userHidden: false })).toBe(true)
    // closed again, or wide enough for all three: the left panel comes back
    expect(autoFold({ winW: 960, sideW: 300, chW: CH_TIGHT, open: false, chat: true, userHidden: false })).toBe(false)
    expect(autoFold({ winW: 1300, sideW: 300, chW: CH_DEFAULT, open: true, chat: true, userHidden: false })).toBe(false)
    expect(canOpen({ winW: 715 })).toBe(false)
  })
})
