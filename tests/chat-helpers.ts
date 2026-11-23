/**
 * Shared helpers for the chat lens tests: the fixtures' lines with their byte
 * offsets, and a check of an item against the event model's field lists
 * (src/chat/types.ts). Not a test file itself.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const FIX = join(__dirname, 'fixtures', 'chat')

/** A fixture's raw text */
export const fixture = (name: string) => readFileSync(join(FIX, name), 'utf8')

/** The fixture's non-empty lines with the byte offset each starts at */
export function linesOf(name: string): { text: string; offset: number }[] {
  const buf = readFileSync(join(FIX, name))
  const out: { text: string; offset: number }[] = []
  let start = 0
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a) {
      const text = buf.subarray(start, i).toString('utf8')
      if (text.trim()) out.push({ text, offset: start })
      start = i + 1
    }
  }
  return out
}

/** A hooks-*.jsonl fixture: { at, event, body } per line */
export const hooksOf = (name: string): { at: number; event: string; body: any }[] => linesOf(name).map(l => JSON.parse(l.text))

// ---- the event model's field lists (src/chat/types.ts), as a runtime check ----

const STATES = ['running', 'done', 'failed', 'rejected', 'interrupted', 'unknown']
const NOTICES = ['interrupted', 'command', 'compact', 'summary', 'agent-done', 'unknown-block', 'model', 'prompt-blocked']
const INPUT_KEYS: Record<string, string> = {
  file: 'string', command: 'string', description: 'string', pattern: 'string', path: 'string', url: 'string',
  query: 'string', question: 'string', options: 'string[]', previews: 'string[]', answer: 'string', plan: 'string', todos: 'todos', agentType: 'string', server: 'string', mcpTool: 'string', background: 'true',
}

type Problem = string
function check(cond: boolean, problems: Problem[], what: string) { if (!cond) problems.push(what) }
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
const only = (o: Record<string, unknown>, allowed: string[], problems: Problem[], where: string) => {
  for (const k of Object.keys(o)) check(allowed.includes(k), problems, `${where}: unexpected key ${k}`)
}

function checkDiff(d: any, problems: Problem[]) {
  only(d, ['file', 'kind', 'added', 'removed', 'hunks', 'hidden', 'truncated'], problems, 'diff')
  check(d.truncated === undefined || d.truncated === true, problems, 'diff.truncated')
  check(typeof d.file === 'string', problems, 'diff.file')
  check(['edit', 'create', 'write'].includes(d.kind), problems, 'diff.kind')
  for (const k of ['added', 'removed', 'hidden']) check(isNum(d[k]) && d[k] >= 0, problems, `diff.${k}`)
  check(Array.isArray(d.hunks), problems, 'diff.hunks')
  for (const h of d.hunks ?? []) {
    only(h, ['oldStart', 'newStart', 'lines'], problems, 'hunk')
    check(isNum(h.oldStart) && isNum(h.newStart) && Array.isArray(h.lines), problems, 'hunk fields')
    for (const l of h.lines ?? []) {
      only(l, ['t', 'old', 'new', 'text'], problems, 'diff line')
      check(['+', '-', ' '].includes(l.t), problems, 'diff line t')
      check((l.old === null || isNum(l.old)) && (l.new === null || isNum(l.new)) && typeof l.text === 'string', problems, 'diff line fields')
    }
  }
}

/** The problems with an item, judged by the event model (an empty list: it fits) */
export function itemProblems(item: any): Problem[] {
  const p: Problem[] = []
  check(!!item && typeof item === 'object', p, 'not an object')
  if (!p.length) {
    check(typeof item.id === 'string' && item.id.length > 0, p, 'id')
    check(isNum(item.order), p, 'order')
    check(item.at === null || isNum(item.at), p, 'at')
    check(item.parent === undefined || typeof item.parent === 'string', p, 'parent')
    const base = ['id', 'order', 'at', 'parent', 'kind']
    switch (item.kind) {
      case 'user':
        // (pending, local: the page's own provisional bubble, src/chat/outbox.ts; main sends pending 'sent' alone for a
        // prompt shown from its hook, electron/chatLens.cjs showPrompt)
        only(item, [...base, 'text', 'images', 'truncated', 'pending', 'local'], p, 'user')
        check(item.pending === undefined || ['sending', 'sent', 'unconfirmed'].includes(item.pending), p, 'user.pending')
        check(typeof item.text === 'string' && isNum(item.images), p, 'user fields')
        break
      case 'text':
        only(item, [...base, 'text', 'partial', 'truncated'], p, 'text')
        check(typeof item.text === 'string', p, 'text.text')
        check(item.partial === undefined || typeof item.partial === 'boolean', p, 'text.partial')
        break
      case 'tool':
        only(item, [...base, 'tool', 'input', 'state', 'waiting', 'output', 'diff', 'durationMs', 'agentId', 'agentTools'], p, 'tool')
        check(item.tool === null || typeof item.tool === 'string', p, 'tool.tool')
        check(STATES.includes(item.state), p, `tool.state ${item.state}`)
        check(item.waiting === undefined || ['permission', 'question', 'plan'].includes(item.waiting), p, 'tool.waiting')
        check(!!item.input && typeof item.input === 'object', p, 'tool.input')
        for (const [k, v] of Object.entries(item.input ?? {})) {
          const t = INPUT_KEYS[k]
          check(!!t, p, `tool.input.${k} unknown`)
          if (t === 'string') check(typeof v === 'string', p, `tool.input.${k}`)
          if (t === 'string[]') check(Array.isArray(v) && (v as unknown[]).every(x => typeof x === 'string'), p, `tool.input.${k}`)
          if (t === 'todos') check(isNum((v as any)?.done) && isNum((v as any)?.total), p, 'tool.input.todos')
          if (t === 'true') check(v === true, p, `tool.input.${k}`)
        }
        if (item.output !== undefined) {
          only(item.output, ['text', 'lines', 'truncated', 'error'], p, 'output')
          check(typeof item.output.text === 'string' && isNum(item.output.lines) && typeof item.output.truncated === 'boolean' && typeof item.output.error === 'boolean', p, 'output fields')
        }
        if (item.diff !== undefined) checkDiff(item.diff, p)
        check(item.durationMs === undefined || isNum(item.durationMs), p, 'durationMs')
        check(item.agentId === undefined || typeof item.agentId === 'string', p, 'agentId')
        check(item.agentTools === undefined || isNum(item.agentTools), p, 'agentTools')
        break
      case 'notice':
        only(item, [...base, 'notice', 'text', 'by'], p, 'notice')
        check(NOTICES.includes(item.notice), p, 'notice.notice')
        check(item.text === undefined || typeof item.text === 'string', p, 'notice.text')
        break
      case 'turn-end':
        only(item, [...base, 'durationMs'], p, 'turn-end')
        check(isNum(item.durationMs), p, 'turn-end.durationMs')
        break
      case 'shell':
        // (a ! command, Claude Code's bash mode: its input line, completed by its output line)
        only(item, [...base, 'command', 'state', 'stdout', 'stderr', 'truncated'], p, 'shell')
        check(typeof item.command === 'string', p, 'shell.command')
        check(item.state === 'running' || item.state === 'done', p, 'shell.state')
        check(item.stdout === undefined || typeof item.stdout === 'string', p, 'shell.stdout')
        check(item.stderr === undefined || typeof item.stderr === 'string', p, 'shell.stderr')
        check(item.truncated === undefined || item.truncated === true, p, 'shell.truncated')
        break
      case 'thinking':
        // (a thinking block, shown from 생각 포함; Claude Code 2.1.32x writes its text empty)
        only(item, [...base, 'text', 'durationMs', 'redacted', 'truncated', 'update'], p, 'thinking')
        check(item.update === undefined || item.update === true, p, 'thinking.update')
        check(typeof item.text === 'string', p, 'thinking.text')
        check(item.durationMs === undefined || (isNum(item.durationMs) && item.durationMs >= 0), p, 'thinking.durationMs')
        check(item.redacted === undefined || item.redacted === true, p, 'thinking.redacted')
        check(item.truncated === undefined || item.truncated === true, p, 'thinking.truncated')
        break
      case 'live':
        only(item, [...base, 'text'], p, 'live')
        check(typeof item.text === 'string', p, 'live.text')
        break
      default:
        p.push(`unknown kind ${item.kind}`)
    }
  }
  return p
}
