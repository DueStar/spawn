/**
 * Words left on the terminal's prompt row stop a chat send (prompt-busy). Instead of sending the user to the
 * terminal, the chat can clear them: the caret to the end of its line (Ctrl+E), then as many Backspaces
 * as there are characters, then the row read again — at most three rounds (a caret left mid-text leaves a tail the
 * next round takes). Only a row the screen shows as empty, or with only a dim suggestion, counts as cleared; a
 * dialog or an unreadable row stops it at once. Pure: the screen, the keys and the clock are injected.
 */

import { promptRow, type RowVerdict } from './promptRow'
import { sentMatches } from './outbox'

/**
 * The words on the terminal's prompt row are the chat's own: the same as a message it sent lately (Claude Code put
 * a blocked prompt back, or a send never got its Enter). Those it clears by itself; anything else is the user's.
 * (the row may show a long message cut or wrapped: a start of 10 characters or more counts)
 */
export function ownLeftover(row: string, sent: readonly string[]): boolean {
  const r = row.replace(/\s+/g, ' ').trim()
  if ([...r].length < 10 && !sent.some(s => s.replace(/\s+/g, ' ').trim() === r && r)) return false
  return sent.some(s => {
    const one = s.replace(/\s+/g, ' ').trim()
    return sentMatches(one, r) || (one.startsWith(r) && [...r].length >= 10)
  })
}

export interface ClearDeps {
  read(): { screen: string | null; dim: string | null }
  /** end: Ctrl+E; backspace: `n` Backspaces at once (main caps it) */
  key(k: 'end' | 'backspace', n?: number): Promise<boolean>
  sleep(ms: number): Promise<void>
}

const clear = (r: RowVerdict) => r.kind === 'empty' || (r.kind === 'text' && r.typed === false)
const rowOf = (d: ClearDeps) => { const x = d.read(); return promptRow(x.screen, x.dim) }

export async function clearPromptRow(d: ClearDeps, limits = { rounds: 3, stepMs: 60, waitMs: 1200 }): Promise<boolean> {
  for (let round = 0; round < limits.rounds; round++) {
    const row = rowOf(d)
    if (clear(row)) return true
    if (row.kind !== 'text') return false
    // (every character, a line break counting as one, and a margin for spaces the reading trimmed)
    const n = [...row.text].length + 4
    if (!(await d.key('end')) || !(await d.key('backspace', n))) return false
    for (let w = 0; w < limits.waitMs; w += limits.stepMs) {
      await d.sleep(limits.stepMs)
      const now = rowOf(d)
      if (clear(now) || now.kind !== 'text' || now.text !== row.text) break
    }
  }
  return clear(rowOf(d))
}
