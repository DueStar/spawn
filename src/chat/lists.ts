/**
 * A list going on in the composer: Shift+Enter (a new line) on a `- `, `* `, `• ` or `1. ` line starts the next item
 * with the same mark (a number counts up), indent kept; on an item with nothing written after its mark, the mark
 * goes instead and the line is left empty (the list ends), as notes apps do. Pure: the textarea's value and caret
 * in, the edit to make out.
 */

export interface ListEdit { start: number; end: number; insert: string }

const ITEM = /^([ \t]*)([-*•]|(\d{1,3})([.)]))[ \t]+/

export function continueList(value: string, caret: number): ListEdit | null {
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1
  const nl = value.indexOf('\n', caret)
  const lineEnd = nl < 0 ? value.length : nl
  const line = value.slice(lineStart, lineEnd)
  const m = ITEM.exec(line)
  // (the caret inside the mark itself: an ordinary new line)
  if (!m || caret - lineStart < m[0].length) return null
  const [mark, indent, bullet, num, sep] = m
  if (!line.slice(mark.length).trim()) return { start: lineStart, end: lineEnd, insert: '' }
  const next = num !== undefined ? `${Number(num) + 1}${sep}` : bullet
  return { start: caret, end: caret, insert: `\n${indent}${next} ` }
}
