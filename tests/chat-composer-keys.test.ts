/**
 * src/chat/composerKeys.ts — what a key does in the chat composer. The Korean and Japanese
 * IMEs own every key while they compose: Enter never sends half a syllable, Esc never stops
 * the work, Backspace never deletes a chip. Sequences as the browsers deliver them.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createImeTracker, keyAction, type KeyLike } from '../src/chat/composerKeys'

const key = (k: string, o: Partial<KeyLike> = {}): KeyLike => ({ key: k, code: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: k === 'Enter' ? 13 : k === 'Escape' ? 27 : 0, ...o })
const idle = { composing: false, working: false, menuOpen: false, lightbox: false }

describe('the IME sequences', () => {
  it('Windows Korean: Enter while composing does nothing; after compositionend, Enter sends once', () => {
    const ime = createImeTracker()
    const sent: string[] = []
    const press = (e: KeyLike) => { const a = keyAction(e, { ...idle, composing: ime.composing() }); if (a) sent.push(a) }
    ime.start()
    press(key('Enter', { keyCode: 229, isComposing: true }))
    expect(sent).toEqual([])
    ime.end()
    press(key('Enter'))
    expect(sent).toEqual(['send'])
  })

  it('macOS Korean: one keydown with isComposing, no second one: nothing sent (the next Enter sends)', () => {
    const ime = createImeTracker()
    ime.start()
    expect(keyAction(key('Enter', { isComposing: true }), { ...idle, composing: ime.composing() })).toBeNull()
    ime.end()
    expect(keyAction(key('Enter'), { ...idle, composing: ime.composing() })).toBe('send')
  })

  it('Japanese: Enter while converting confirms the conversion only; the next Enter sends', () => {
    const ime = createImeTracker()
    ime.start()
    expect(keyAction(key('Enter', { keyCode: 229 }), { ...idle, composing: ime.composing() })).toBeNull()
    ime.end()
    expect(keyAction(key('Enter'), { ...idle, composing: ime.composing() })).toBe('send')
  })

  it('Backspace, Esc, arrows while composing belong to the IME (Esc never stops, even while working)', () => {
    const ime = createImeTracker()
    ime.start()
    for (const k of ['Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'Tab', 'Enter']) {
      expect(keyAction(key(k), { composing: ime.composing(), working: true, menuOpen: true, lightbox: false }), k).toBeNull()
      expect(keyAction(key(k, { isComposing: true }), { ...idle, working: true, menuOpen: true }), k).toBeNull()
      expect(keyAction(key(k, { keyCode: 229 }), { ...idle, working: true }), k).toBeNull()
    }
  })

  it('losing the focus ends the composition (the text stays the textarea\'s own)', () => {
    const ime = createImeTracker()
    ime.start()
    expect(ime.composing()).toBe(true)
    ime.blur()
    expect(ime.composing()).toBe(false)
  })
})

describe('keys outside a composition', () => {
  it('Enter sends; Shift+Enter is the textarea\'s newline; Enter with Ctrl, ⌘ or Alt does nothing', () => {
    expect(keyAction(key('Enter'), idle)).toBe('send')
    expect(keyAction(key('Enter', { shiftKey: true }), idle)).toBeNull()
    expect(keyAction(key('Enter', { ctrlKey: true }), idle)).toBeNull()
    expect(keyAction(key('Enter', { metaKey: true }), idle)).toBeNull()
    expect(keyAction(key('Enter', { altKey: true }), idle)).toBeNull()
  })

  it('Esc stops only while Claude works; otherwise nothing', () => {
    expect(keyAction(key('Escape'), { ...idle, working: true })).toBe('stop')
    expect(keyAction(key('Escape'), idle)).toBeNull()
    expect(keyAction(key('Escape', { shiftKey: true }), { ...idle, working: true })).toBeNull()
  })

  it('a menu open: ↑ ↓ move, Enter or Tab pick, Esc closes the menu only (never stops)', () => {
    const s = { ...idle, menuOpen: true, working: true }
    expect(keyAction(key('ArrowUp'), s)).toBe('menu-up')
    expect(keyAction(key('ArrowDown'), s)).toBe('menu-down')
    expect(keyAction(key('Enter'), s)).toBe('menu-pick')
    expect(keyAction(key('Tab'), s)).toBe('menu-pick')
    expect(keyAction(key('Escape'), s)).toBe('menu-close')
    expect(keyAction(key('Enter', { shiftKey: true }), s)).toBeNull()
  })

  it('the lightbox open: Esc closes it, nothing else happens', () => {
    const s = { ...idle, lightbox: true, working: true, menuOpen: true }
    expect(keyAction(key('Escape'), s)).toBe('lightbox-close')
    expect(keyAction(key('Enter'), s)).toBeNull()
  })

  it('other keys: nothing', () => {
    for (const k of ['a', 'Backspace', 'ArrowUp', 'Tab', ' ']) expect(keyAction(key(k), { ...idle, working: true }), k).toBeNull()
  })
})

describe('the @ mention at the caret', () => {
  it('an @ at the start or after whitespace, up to the caret; nothing else', async () => {
    const { mentionAt } = await import('../src/chat/composerKeys')
    expect(mentionAt('@src', 4)).toEqual({ start: 0, query: 'src' })
    expect(mentionAt('look at @mid', 12)).toEqual({ start: 8, query: 'mid' })
    expect(mentionAt('look at @', 9)).toEqual({ start: 8, query: '' })
    expect(mentionAt('mail me@example', 15)).toBeNull()
    expect(mentionAt('@a@b', 4)).toBeNull()
    expect(mentionAt('@src done', 9)).toBeNull()
    expect(mentionAt('줄 바꿈\n@파일', 8)).toEqual({ start: 5, query: '파일' })
  })
})

describe('the review of Phase 3 (fixed)', () => {
  it('m1: Esc while a mention is typed (its menu still loading) closes the mention, never stops the work', () => {
    const s = { ...idle, working: true, menuOpen: false, mentionOpen: true }
    expect(keyAction(key('Escape'), s)).toBe('menu-close')
    // no mention: Esc stops, as before
    expect(keyAction(key('Escape'), { ...idle, working: true })).toBe('stop')
    // composing still wins
    expect(keyAction(key('Escape', { isComposing: true }), s)).toBeNull()
  })

  it('m1: an Esc right after the one that closed the menu does not stop either (Composer source)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'components', 'chat', 'Composer.tsx'), 'utf8')
    expect(src).toContain('mentionOpen: !!mention')
    expect(src).toMatch(/a === 'stop'\) \{ e\.preventDefault\(\); if \(Date\.now\(\) - menuClosedAt\.current > ESC_AFTER_MENU_MS\)/)
  })
})
