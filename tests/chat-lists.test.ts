import { describe, expect, it } from 'vitest'
import { continueList } from '../src/chat/lists'

const at = (v: string) => continueList(v, v.length)

describe('a list going on in the composer (Shift+Enter)', () => {
  it('a bullet line starts the next bullet, its mark and indent kept', () => {
    expect(at('- 첫째')).toEqual({ start: 4, end: 4, insert: '\n- ' })
    expect(at('메모\n  * 안쪽')).toEqual({ start: 9, end: 9, insert: '\n  * ' })
    expect(at('• 점')).toEqual({ start: 3, end: 3, insert: '\n• ' })
  })
  it('a numbered line counts up', () => {
    expect(at('1. 하나')).toEqual({ start: 5, end: 5, insert: '\n2. ' })
    expect(at('9) 아홉')).toEqual({ start: 5, end: 5, insert: '\n10) ' })
  })
  it('an empty item ends the list: its mark goes', () => {
    expect(at('- a\n- ')).toEqual({ start: 4, end: 6, insert: '' })
    expect(at('- a\n2. ')).toEqual({ start: 4, end: 7, insert: '' })
  })
  it('not a list line, or the caret in the mark: an ordinary new line', () => {
    expect(at('그냥 글')).toBeNull()
    expect(at('-붙은 글')).toBeNull()
    // (a date is not a numbered item: at most three digits)
    expect(at('2026. 11. 17')).toBeNull()
    expect(continueList('- 첫째', 1)).toBeNull()
  })
})
