/**
 * Claude Code's `thinkingDisplay: "updates"`: a thinking block with text is the progress note the terminal shows
 * (a note seen in the terminal showed nothing in the chat).
 * The hidden thinking is written empty. The chat shows the notes in 기본, as prose.
 */
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { itemProblems } from './chat-helpers'
import { buildRows } from '../src/chat/rows'

const require = createRequire(import.meta.url)
const { createItemBuilder } = require('../electron/chatItems.cjs')

const line = (uuid: string, blocks: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'assistant', uuid, timestamp: '2026-11-17T06:50:00.000Z', thinkingDisplay: 'updates',
  message: { role: 'assistant', content: blocks, stop_reason: 'tool_use' }, ...extra,
})

describe('progress notes (thinkingDisplay: updates)', () => {
  it('a thinking block with text is an update; an empty one is not', () => {
    const b = createItemBuilder({ cwd: 'C:\w' })
    const [note] = b.line(line('a1', [{ type: 'thinking', thinking: '판매 페이지를 캡처했어요.', signature: 'x' }]), 10)
    expect(note).toMatchObject({ kind: 'thinking', text: '판매 페이지를 캡처했어요.', update: true })
    expect(itemProblems(note)).toEqual([])
    const [hidden] = b.line(line('a2', [{ type: 'thinking', thinking: '', signature: 'x' }]), 20)
    expect(hidden.update).toBeUndefined()
  })
  it('another display mode: an ordinary thinking block', () => {
    const b = createItemBuilder({ cwd: 'C:\w' })
    const [t] = b.line(line('a1', [{ type: 'thinking', thinking: 'hmm', signature: 'x' }], { thinkingDisplay: 'summary' }), 10)
    expect(t.update).toBeUndefined()
  })
  it('기본 shows an update as a row; a plain thinking block stays hidden', () => {
    const items = [
      { id: 'u', order: 1, at: null, kind: 'user', text: 'go', images: 0 },
      { id: 'n', order: 2, at: null, kind: 'thinking', text: '캡처했어요.', update: true },
      { id: 'h', order: 3, at: null, kind: 'thinking', text: 'secret' },
    ] as any[]
    const rows = buildRows(items, { density: 'default' } as any)
    expect(rows.filter(r => r.row === 'thinking').map(r => r.key)).toEqual(['n'])
  })
})
