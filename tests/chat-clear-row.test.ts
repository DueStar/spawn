import { describe, expect, it } from 'vitest'
import { clearPromptRow } from '../src/chat/clearRow'

const R = '─'.repeat(40)
const screenOf = (row: string) => ['x', R, `❯ ${row}`, R, '  Opus 5.5 · ctx 3%', '  ⏵⏵ auto mode on'].join('\n')

/** A prompt row holding `text` with the caret at `caret`; Ctrl+E moves it to the end, Backspace deletes before it */
function term(text: string, caret = text.length) {
  let t = text
  let c = caret
  const keys: string[] = []
  return {
    keys, text: () => t,
    deps: {
      read: () => ({ screen: screenOf(t), dim: null }),
      key: async (k: 'end' | 'backspace', n = 1) => {
        keys.push(k === 'end' ? 'end' : `bs${n}`)
        if (k === 'end') c = t.length
        else { const from = Math.max(0, c - n); t = t.slice(0, from) + t.slice(c); c = from }
        return true
      },
      sleep: async () => {},
    },
  }
}

describe('clearing the words left on the prompt row', () => {
  it('the caret at the end: one round', async () => {
    const x = term('쓰다 만 문장')
    expect(await clearPromptRow(x.deps)).toBe(true)
    expect(x.text()).toBe('')
    expect(x.keys).toEqual(['end', 'bs11'])
  })
  it('the caret in the middle: Ctrl+E first, so one round still does it', async () => {
    const x = term('hello world', 3)
    expect(await clearPromptRow(x.deps)).toBe(true)
    expect(x.text()).toBe('')
  })
  it('an empty row: nothing pressed', async () => {
    const x = term('')
    expect(await clearPromptRow(x.deps)).toBe(true)
    expect(x.keys).toEqual([])
  })
  it('a row that will not clear, or no box: false', async () => {
    const stuck = { read: () => ({ screen: screenOf('stays'), dim: null }), key: async () => true, sleep: async () => {} }
    expect(await clearPromptRow(stuck, { rounds: 2, stepMs: 10, waitMs: 20 })).toBe(false)
    const none = { read: () => ({ screen: 'no box here', dim: null }), key: async () => true, sleep: async () => {} }
    expect(await clearPromptRow(none)).toBe(false)
  })
})
