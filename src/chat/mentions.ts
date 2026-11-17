/**
 * The files a message refers to: `@path` tokens, as the composer's @ menu writes them (`@src/a.ts `) and as
 * Claude Code reads them. A token starts the text or follows whitespace (an e-mail's @ is not one), runs to the
 * next whitespace, and holds no second @. Pure: the composer's badges and the sent bubble's both read this.
 */

export interface Mention { start: number; end: number; path: string }

const TOKEN = /(^|\s)@([^\s@]+)/g
// a sentence's own end after a path ("@a.ts," / "@a.ts.") is not part of it
const TRAIL = /[.,;:!?)\]}'"]+$/

export function mentionsIn(text: string): Mention[] {
  const out: Mention[] = []
  for (const m of text.matchAll(TOKEN)) {
    const path = m[2].replace(TRAIL, '')
    if (!path) continue
    const start = (m.index ?? 0) + m[1].length
    out.push({ start, end: start + 1 + path.length, path })
  }
  return out
}

/** The file's own name (the last part of the path), for a badge */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

export type Segment = { kind: 'text'; text: string } | { kind: 'file'; path: string }

/** The text cut at its mentions, for the bubble: text, a file, text… */
export function splitMentions(text: string): Segment[] {
  const out: Segment[] = []
  let at = 0
  for (const m of mentionsIn(text)) {
    if (m.start > at) out.push({ kind: 'text', text: text.slice(at, m.start) })
    out.push({ kind: 'file', path: m.path })
    at = m.end
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) })
  return out
}

/** The message as sent: the picked files first, as Claude Code reads them (`@a.ts @b.ts text`) */
export function withRefs(refs: string[], text: string): string {
  if (!refs.length) return text
  const head = refs.map(f => `@${f}`).join(' ')
  return text.trim() ? `${head} ${text}` : head
}

/**
 * The files at the very start of a sent message (the composer's badges, withRefs) apart from its text, for the bubble:
 * they show over it as file pills, as the pictures do. A mention inside the sentence stays in the text.
 */
export function leadingRefs(text: string): { refs: string[]; body: string } {
  const refs: string[] = []
  let at = 0
  const lead = /^\s*@([^\s@]+)(?=\s|$)/
  for (;;) {
    const m = lead.exec(text.slice(at))
    if (!m) break
    refs.push(m[1])
    at += m[0].length
  }
  return { refs, body: refs.length ? text.slice(at).replace(/^[ \t]+/, '') : text }
}
