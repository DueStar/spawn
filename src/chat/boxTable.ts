/**
 * Tables Claude Code draws in the terminal (2026-11-19, the owner's report: a table Claude wrote showed up in the chat
 * as raw special characters). Claude Code 2.1.32x renders a markdown table on the screen with box-drawing lines:
 *
 *   ┌──────┬───────┐
 *   │ Name │ Value │      a header row (a cell's words may wrap onto more lines of the same row)
 *   ├──────┼───────┤
 *   │ a    │ 1     │      each row, then a ├…┤ line between rows
 *   ├──────┼───────┤
 *   │ b    │ 2     │
 *   └──────┴───────┘
 *
 * Text the chat takes from the screen (a dialog's body: a plan or a question drawn over its choices) then carries those
 * lines. Here they become rows and cells again when the block is whole (top, header, rows, bottom, the same number of
 * cells on every line); a block that is not (cut at the top of what was read, wrapped by a narrow terminal) is kept as
 * lines to show in a monospace block, so its columns still line up. Pure; linear in the lines.
 */

export interface BoxTable { head: string[]; rows: string[][] }
export type BoxSegment = { kind: 'text'; lines: string[] } | { kind: 'table'; table: BoxTable } | { kind: 'mono'; lines: string[] }

const TOP = /^\s*┌─[─┬]*┐\s*$/
const MID = /^\s*├─[─┼]*┤\s*$/
const BOTTOM = /^\s*└─[─┴]*┘\s*$/
const ROW = /^\s*│.*│\s*$/
/** any line of a drawn table (whole or not) */
const BOXY = /^\s*[┌├└│][─┬┼┴┐┤┘│ ]?/
export const isBoxLine = (l: string) => BOXY.test(l) && /[─│]/.test(l)

const cellsOf = (l: string) => l.trim().slice(1, -1).split('│').map(c => c.trim())
const segmentsOf = (border: string) => border.trim().slice(1, -1).split(/[┬┼┴]/).length

/** The whole table starting at `lines[i]` (its top border), and the line after it; null when it is not whole */
export function boxTableAt(lines: string[], i: number): { table: BoxTable; end: number } | null {
  if (!TOP.test(lines[i] ?? '')) return null
  const cols = segmentsOf(lines[i])
  const groups: string[][][] = [[]]
  let seps = 0
  let j = i + 1
  for (; j < lines.length; j++) {
    const l = lines[j]
    if (BOTTOM.test(l)) { if (segmentsOf(l) !== cols) return null; break }
    if (MID.test(l)) { if (segmentsOf(l) !== cols) return null; groups.push([]); seps++; continue }
    if (!ROW.test(l)) return null
    const cells = cellsOf(l)
    if (cells.length !== cols) return null
    groups[groups.length - 1].push(cells)
  }
  if (j >= lines.length || seps < 1 || groups.some(g => !g.length)) return null
  // a row drawn on several lines (its cells' words wrapped): one row, each cell's pieces joined
  const join = (g: string[][]) => Array.from({ length: cols }, (_, c) => g.map(r => r[c]).filter(Boolean).join(' '))
  // (one ├ line only: the header above it, then a row per line — a table drawn without lines between rows)
  const rows = seps === 1 ? groups[1].map(r => [...r]) : groups.slice(1).map(join)
  return { table: { head: join(groups[0]), rows }, end: j + 1 }
}

/** Lines split into plain text, whole tables, and drawn lines that are not a whole table (shown monospace) */
export function boxSegments(lines: string[]): BoxSegment[] {
  const out: BoxSegment[] = []
  const push = (kind: 'text' | 'mono', l: string) => {
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.lines.push(l)
    else out.push({ kind, lines: [l] })
  }
  for (let i = 0; i < lines.length; i++) {
    const t = boxTableAt(lines, i)
    if (t) { out.push({ kind: 'table', table: t.table }); i = t.end - 1; continue }
    push(isBoxLine(lines[i]) ? 'mono' : 'text', lines[i])
  }
  return out
}

const cell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')

/**
 * Markdown with each whole drawn table written as a GFM table (outside fenced code, which stays as it is), so the
 * chat's markdown shows it as a table; anything else unchanged
 */
export function unboxTables(text: string): string {
  if (!text.includes('┌')) return text
  const lines = text.split('\n')
  const out: string[] = []
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(l)
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; out.push(l); continue }
    const t = fence ? null : boxTableAt(lines, i)
    if (!t) { out.push(l); continue }
    const { head, rows } = t.table
    if (out.length && out[out.length - 1].trim()) out.push('')
    out.push(`| ${head.map(cell).join(' | ')} |`, `|${head.map(() => ' --- ').join('|')}|`, ...rows.map(r => `| ${r.map(cell).join(' | ')} |`))
    if (t.end < lines.length && lines[t.end].trim()) out.push('')
    i = t.end - 1
  }
  return out.join('\n')
}
