import { describe, expect, it } from 'vitest'
import { suggestionOf } from '../src/chat/promptRow'

describe('the next-prompt suggestion', () => {
  it('dim text nobody typed is a suggestion', () => {
    expect(suggestionOf({ kind: 'text', text: 'run the tests', typed: false })).toBe('run the tests')
  })
  it('the stock Try "…" hint is not', () => {
    expect(suggestionOf({ kind: 'text', text: 'Try "refactor <filepath>"', typed: false })).toBeNull()
  })
  it('typed text, unknown marks, an empty row or a dialog: none', () => {
    expect(suggestionOf({ kind: 'text', text: 'hello', typed: true })).toBeNull()
    expect(suggestionOf({ kind: 'text', text: 'hello' })).toBeNull()
    expect(suggestionOf({ kind: 'empty' })).toBeNull()
    expect(suggestionOf({ kind: 'unknown', why: 'dialog' })).toBeNull()
  })
})
