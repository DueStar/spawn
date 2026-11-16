/**
 * tests/fixtures/chat — the redacted transcripts and hook sequences the chat
 * lens is tested with. They are hand-written in the shapes the spike recorded
 * (Claude Code 2.1.323): every value that is not structure is replaced. This
 * guard keeps them that way: no user name, home path, real id, key or token
 * can slip into the repository through a fixture.
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, userInfo } from 'node:os'
import { basename, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = join(__dirname, 'fixtures', 'chat')

// ---- what must never be in a tracked file, without writing any of it into one (re-review m-13)

/**
 * The machine owner's names, read at run time (the user name and the home folder's name): whoever
 * runs the tests is who the fixtures and test sources must not name. A generic account name (a CI
 * runner's) is left out, as is anything shorter than three characters.
 */
const GENERIC_NAMES = new Set(['user', 'runner', 'root', 'admin', 'administrator', 'node', 'ubuntu', 'vscode', 'codespace', 'codespaces', 'default', 'guest', 'test'])
function ownerNames(): string[] {
  const names = new Set<string>()
  try { names.add(userInfo().username) } catch { /* no account name */ }
  try { names.add(basename(homedir())) } catch { /* no home */ }
  return [...names].map(n => n.trim()).filter(n => n.length >= 3 && !GENERIC_NAMES.has(n.toLowerCase()))
}

/**
 * Private strings known only by their SHA-256 (hex): a 16-hex-digit value the spike's real logs held.
 * Every run of 16 hex digits in a text is hashed and compared; the value itself is never written here.
 */
const PRIVATE_DIGESTS = new Set(['80a9e9e98b0bf51abf641fea39d52b950d81bbc83a31ac4beb157d54b2699233'])
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

interface Secrets { owners: string[]; digests: Set<string> }
const SECRETS: Secrets = { owners: ownerNames(), digests: PRIVATE_DIGESTS }

/** The private things in a text: an owner's name (as a word, any case) or a hex run whose hash is listed */
function privateHits(text: string, secrets: Secrets = SECRETS): string[] {
  const out: string[] = []
  const lower = text.toLowerCase()
  for (const name of secrets.owners) {
    const n = name.toLowerCase()
    for (let at = lower.indexOf(n); at >= 0; at = lower.indexOf(n, at + 1)) {
      const before = lower[at - 1] ?? ''
      const after = lower[at + n.length] ?? ''
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) { out.push('the machine owner\'s name'); break }
    }
  }
  for (const m of text.matchAll(/(?<![0-9a-f])[0-9a-f]{16}(?![0-9a-f])/gi)) if (secrets.digests.has(sha256(m[0].toLowerCase()))) out.push('a private hex string')
  return out
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

const FILES = walk(DIR)
const rel = (p: string) => relative(DIR, p).split('\\').join('/')

/**
 * The binary fixtures (Phase 5: the link previews' images), each listed by name with its SHA-256 and what
 * its header says: no binary can come into the folder unseen. `fake.png` is HTML under a picture's name.
 */
const BINARIES: Record<string, { sha256: string; type: 'png' | 'jpeg' | 'webp' | 'gif' | 'html'; width?: number; height?: number }> = {
  'preview/tiny.png': { sha256: '48f014ae6deb858ada571a60b060cd27a273a1b4f965c07abf38b7bb74863ac7', type: 'png', width: 3, height: 2 },
  'preview/tiny.jpg': { sha256: '14e3049d754b129de7517660e772e6283ae9da4dc70d3787c192e2f103314d94', type: 'jpeg', width: 10, height: 6 },
  'preview/tiny.webp': { sha256: '2ebcf50e92d487e3a18135be7a46984103d519629c4e59149b134cb485ec0fbb', type: 'webp', width: 6, height: 4 },
  'preview/anim.png': { sha256: '518d59ecec787b1d038c6a8ed19a7a2e8d02f44ff6ea6df459eadb395ce86811', type: 'png', width: 4, height: 4 },
  'preview/tiny.gif': { sha256: '15ad6da9845336fad998195e6b4b08206a426ac80ac211477b14d0ea08ce6f77', type: 'gif', width: 5, height: 3 },
  'preview/huge-dims.png': { sha256: 'ec594dea066d923c5b03d6ad39ba3cf1493acab3ac06be9f25c94b488f59ef1d', type: 'png', width: 30000, height: 30000 },
  'preview/fake.png': { sha256: '8a521da0a0d5e2e9ae4b3c3dafb845b5ea0774a86ba7ed5e560adcd5ae648083', type: 'html' },
}
const isBinary = (p: string) => rel(p) in BINARIES || /\.(png|jpe?g|webp|gif|bmp|ico|avif|svg)$/i.test(p)
/** The fixtures that are text: everything the privacy scans read */
const TEXTS = FILES.filter(f => !isBinary(f))

/** A fixture's text (og-euckr.html is EUC-KR bytes, as its meta says) */
function textOf(file: string): string {
  const bytes = readFileSync(file)
  return rel(file) === 'preview/og-euckr.html' ? new TextDecoder('euc-kr').decode(bytes) : bytes.toString('utf8')
}

/** Every string value in a parsed JSON value, with its key */
function strings(v: unknown, key = '', out: { key: string; value: string }[] = []) {
  if (typeof v === 'string') out.push({ key, value: v })
  else if (Array.isArray(v)) v.forEach(x => strings(x, key, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) strings(x, k, out)
  return out
}

/** The parsed lines of a fixture (.jsonl: one per non-empty line; .json: the one value; .txt: each line as a string; .html: the whole text) */
function parsed(file: string): { line: number; value: unknown }[] {
  const text = textOf(file)
  if (file.endsWith('.html')) return [{ line: 1, value: text }]
  if (file.endsWith('.txt')) return text.split('\n').map((value, i) => ({ line: i + 1, value })).filter(l => l.value)
  if (file.endsWith('.json')) return [{ line: 1, value: JSON.parse(text) }]
  const out: { line: number; value: unknown }[] = []
  text.split('\n').forEach((raw, i) => {
    if (!raw.trim()) return
    try { out.push({ line: i + 1, value: JSON.parse(raw) }) } catch { /* counted in (a) */ }
  })
  return out
}

// The bookkeeping that carries account data: kept in the fixtures only to prove the lens drops them
const SENSITIVE_TYPES = new Set(['session-owner', 'bridge-session', 'atis-latch', 'api-request', 'api-request-shape', 'api-request-blob', 'cost-state'])
const SENSITIVE_ATTACHMENTS = new Set(['credential_org', 'prompt_snapshot'])

/** Every leaf under `v` other than a `type` discriminator is "REDACTED" */
function allRedacted(v: unknown, key = ''): boolean {
  if (key === 'type') return true
  if (Array.isArray(v)) return v.every(x => allRedacted(x))
  if (v && typeof v === 'object') return Object.entries(v).every(([k, x]) => allRedacted(x, k))
  return v === 'REDACTED'
}

describe('the chat fixtures', () => {
  it('exist', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(14)
    for (const name of ['basic.jsonl', 'tools.jsonl', 'interrupt.jsonl', 'agent.jsonl', 'agent/subagents/agent-afixture01.jsonl',
      'agent/subagents/agent-afixture01.meta.json', 'ask-plan.jsonl', 'image.jsonl', 'commands.jsonl', 'bad.jsonl',
      'hooks-tools.jsonl', 'hooks-stream.jsonl', 'hooks-agent.jsonl', 'mac/basic.jsonl']) {
      expect(FILES.map(rel), name).toContain(name)
    }
  })

  it('every file is of a known kind: text (.jsonl, .json, .txt, .html) or a listed binary', () => {
    for (const file of FILES) expect(/\.(jsonl|json|txt|html)$/.test(file) || rel(file) in BINARIES, rel(file)).toBe(true)
  })

  it('(a) every line is JSON, except the one deliberate bad line in bad.jsonl', () => {
    for (const file of FILES.filter(f => /\.jsonl?$/.test(f))) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim())
      const bad = file.endsWith('.json') ? (() => { try { JSON.parse(readFileSync(file, 'utf8')); return 0 } catch { return 1 } })()
        : lines.filter(l => { try { JSON.parse(l); return false } catch { return true } }).length
      expect(bad, rel(file)).toBe(rel(file) === 'bad.jsonl' ? 1 : 0)
    }
  })

  it('(b) no user name, real id, key, e-mail address or token', () => {
    // (the owner's name and private strings: privateHits, built at run time — none is written here)
    const LEAK = /DueStar|spawn-promo|chat-spike|AppData\\\\Local\\\\Temp\\\\claude|msg_011|toolu_01[A-Za-z0-9]{20}|sk-ant|@[a-z0-9-]+\.[a-z]{2,}|Bearer /i
    for (const file of TEXTS) {
      const text = textOf(file)
      expect(LEAK.exec(text)?.[0] ?? null, rel(file)).toBeNull()
      expect(privateHits(text), rel(file)).toEqual([])
      // also after JSON unescaping (a "\\" in the file is one backslash in the value)
      for (const { value } of parsed(file).flatMap(p => strings(p.value))) {
        expect(LEAK.exec(value)?.[0] ?? null, rel(file)).toBeNull()
        expect(privateHits(value), rel(file)).toEqual([])
      }
    }
  })

  it('(c) every path is under the made-up user: C:\\Users\\user\\ or /Users/user/', () => {
    for (const file of TEXTS) {
      for (const { value } of parsed(file).flatMap(p => strings(p.value))) {
        for (const m of value.matchAll(/(?<![A-Za-z0-9])[A-Za-z]:[\\/]/g)) expect(value.slice(m.index!, m.index! + 14), rel(file)).toBe('C:\\Users\\user\\')
        for (const m of value.matchAll(/C:\\Users\\[^\\]*/g)) expect(m[0], rel(file)).toBe('C:\\Users\\user')
        for (const m of value.matchAll(/\/(Users|home)\/[^/\s"]*/g)) expect(m[0], rel(file)).toBe('/Users/user')
      }
    }
  })

  it('(d) no long string and no long base64 run', () => {
    // the deliberate exceptions: a page's whole text (og-late.html is long by design), and in changes.jsonl the
    // one edit whose new line is 5,000 characters of river names (the diff's line cap)
    const longOk = (file: string, value: string) => file.endsWith('.html')
      || (rel(file) === 'changes.jsonl' && value.length <= 6000 && value.includes("const RIVERS = ['nile', "))
    for (const file of TEXTS) {
      for (const { value } of parsed(file).flatMap(p => strings(p.value))) {
        if (!longOk(file, value)) expect(value.length, rel(file)).toBeLessThanOrEqual(4000)
        expect(/[A-Za-z0-9+/=]{201,}/.test(value), rel(file)).toBe(false)
      }
    }
  })

  it('(e) the bookkeeping that holds account data appears only with "REDACTED" values', () => {
    let seen = 0
    for (const file of FILES) {
      for (const { line, value } of parsed(file)) {
        const v = value as Record<string, any>
        if (!v || typeof v !== 'object') continue
        const where = `${rel(file)}:${line}`
        if (SENSITIVE_TYPES.has(v.type)) { seen++; expect(allRedacted(v), where).toBe(true) }
        if (v.type === 'attachment' && SENSITIVE_ATTACHMENTS.has(v.attachment?.type)) { seen++; expect(allRedacted(v.attachment), where).toBe(true) }
        if ('serverClassifierContext' in v) { seen++; expect(allRedacted(v.serverClassifierContext), where).toBe(true) }
      }
    }
    // each kind is there once at least (they exist to prove they are dropped)
    expect(seen).toBeGreaterThanOrEqual(SENSITIVE_TYPES.size + SENSITIVE_ATTACHMENTS.size + 1)
  })

  it('(f) every hook line has at, event and body, and the body names the same event', () => {
    const hookFiles = FILES.filter(f => /hooks-[^/\\]*\.jsonl$/.test(f))
    expect(hookFiles.length).toBe(6)
    for (const file of hookFiles) {
      for (const { line, value } of parsed(file)) {
        const h = value as { at: unknown; event: unknown; body: { hook_event_name?: unknown } }
        expect(typeof h.at, `${rel(file)}:${line}`).toBe('number')
        expect(typeof h.event, `${rel(file)}:${line}`).toBe('string')
        expect(h.body?.hook_event_name, `${rel(file)}:${line}`).toBe(h.event)
      }
    }
  })
})

// ---- the chat composer's fixtures (Phase 3): terminal screens as text, queue lines, input hook bodies

const SCREENS = [
  'idle-empty', 'idle-placeholder', 'after-turn-suggestion', 'typed', 'typed-multiline', 'working-empty',
  'dialog-bash', 'dialog-edit', 'dialog-plan', 'dialog-trust', 'dialog-question',
  'echo-plain', 'echo-korean', 'echo-pasted', 'echo-image', 'echo-image-pending', 'echo-after-suggestion',
  'narrow-wrap', 'bash-mode', 'no-box-shell', 'short',
  // what the Phase 3 trial showed on Claude Code 2.1.325 (hand-redacted real shapes)
  'real-placeholder-nbsp', 'real-idle-empty-nbsp', 'real-history-recall',
  // the owner's session after 1.5.1: a named session, a subagent running (tests/chat-real-owner-screens.test.ts)
  'real-named-session', 'real-agents-panel',
  // the owner's own app (1.5.3's log): the prompt mark drawn as a plain >
  'real-ascii-mark',
]

describe('the composer fixtures', () => {
  const screens = FILES.filter(f => f.endsWith('.txt'))

  it('exist: every screen, the queue lines and the input hook bodies', () => {
    for (const name of SCREENS) expect(FILES.map(rel), name).toContain(`screens/${name}.txt`)
    for (const name of ['queue.jsonl', 'hooks-input.jsonl']) expect(FILES.map(rel), name).toContain(name)
  })

  it('screens: no escape character, lines of 200 characters at most, paths only under ~\\work\\demo or C:\\Users\\user\\', () => {
    expect(screens.length).toBe(SCREENS.length)
    for (const file of screens) {
      const text = readFileSync(file, 'utf8')
      expect(text.includes('\x1b'), rel(file)).toBe(false)
      for (const line of text.split('\n')) expect(line.length, `${rel(file)}: ${line.slice(0, 40)}`).toBeLessThanOrEqual(200)
      for (const m of text.matchAll(/~[\\/][^\s"]*/g)) expect(m[0], rel(file)).toMatch(/^~\\work\\demo/)
      for (const m of text.matchAll(/(?<![A-Za-z0-9])[A-Za-z]:\\[^\s"]*/g)) expect(m[0].slice(0, 14), rel(file)).toBe('C:\\Users\\user\\')
    }
  })

  it('queue.jsonl: enqueue, enqueue, remove, the queued_command, a dequeue, an unknown operation, the next turn', () => {
    const ops = parsed(join(DIR, 'queue.jsonl')).map(p => p.value as Record<string, any>)
    expect(ops.filter(o => o.type === 'queue-operation').map(o => o.operation)).toEqual(['enqueue', 'enqueue', 'remove', 'dequeue', 'shuffle'])
    expect(ops.some(o => o.type === 'attachment' && o.attachment?.type === 'queued_command')).toBe(true)
    expect(ops.some(o => o.type === 'system' && o.subtype === 'turn_duration')).toBe(true)
  })

  it('hooks-input.jsonl: the permission modes default, acceptEdits, one not known, then plan', () => {
    const modes = parsed(join(DIR, 'hooks-input.jsonl')).map(p => (p.value as { body: { permission_mode?: string } }).body.permission_mode)
    expect(modes).toEqual(['default', 'acceptEdits', 'warp', 'plan'])
  })
})

// ---- the chat's buttons (Phase 4): permission requests, questions, a rejected call, the answers

describe('the answer fixtures', () => {
  const lines = (name: string) => parsed(join(DIR, name)).map(p => p.value as { event: string; body: Record<string, any> })

  it('exist: the permission and question hooks, a rejected call, the four answers', () => {
    for (const name of ['hooks-permission.jsonl', 'hooks-question.jsonl', 'rejected.jsonl', 'answers/allow.json', 'answers/always.json', 'answers/deny.json', 'answers/question.json']) {
      expect(FILES.map(rel), name).toContain(name)
    }
  })

  it('hooks-permission.jsonl: Bash (an addRules suggestion for localSettings), Edit (setMode), a sub-agent, a plan, two of one call, a question', () => {
    const all = lines('hooks-permission.jsonl')
    const perm = all.filter(l => l.event === 'PermissionRequest')
    expect(perm.map(l => l.body.tool_name)).toEqual(['Bash', 'Edit', 'PowerShell', 'ExitPlanMode', 'Bash', 'Bash', 'AskUserQuestion'])
    expect(perm[0].body.permission_suggestions[0]).toMatchObject({ type: 'addRules', behavior: 'allow', destination: 'localSettings' })
    expect(perm[1].body.permission_suggestions[0]).toMatchObject({ type: 'setMode', mode: 'acceptEdits' })
    expect(typeof perm[1].body.tool_input.old_string).toBe('string')
    expect(typeof perm[2].body.agent_id).toBe('string')
    expect(perm[3].body.tool_input.planFilePath).toMatch(/^C:\\Users\\user\\\.claude\\plans\\/)
    expect(perm[4].body.tool_input).toEqual(perm[5].body.tool_input)
    // a PermissionRequest carries no tool_use_id (FINDINGS §2): it is paired by its call key
    for (const l of perm) expect('tool_use_id' in l.body).toBe(false)
    expect(all.some(l => l.event === 'PostToolUse' && l.body.tool_name === 'Bash')).toBe(true)
  })

  it('hooks-question.jsonl: one single-select question, a multi-select one, two questions, a PostToolUse', () => {
    const all = lines('hooks-question.jsonl')
    const pre = all.filter(l => l.event === 'PreToolUse')
    expect(pre.every(l => l.body.tool_name === 'AskUserQuestion')).toBe(true)
    expect(pre.map(l => [l.body.tool_input.questions.length, l.body.tool_input.questions[0].multiSelect])).toEqual([[1, false], [1, true], [2, false]])
    expect(all.at(-1)?.event).toBe('PostToolUse')
  })

  it('answers: the bodies the app may send — the session destination only', () => {
    const json = (name: string) => JSON.parse(readFileSync(join(DIR, 'answers', name), 'utf8'))
    expect(json('allow.json')).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    expect(json('always.json').hookSpecificOutput.decision.updatedPermissions[0].destination).toBe('session')
    expect(json('deny.json').hookSpecificOutput.decision.behavior).toBe('deny')
    expect(json('deny.json').hookSpecificOutput.decision.interrupt).toBeUndefined()
    expect(json('question.json').hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'allow' })
    for (const name of ['allow.json', 'always.json', 'deny.json', 'question.json']) {
      expect(readFileSync(join(DIR, 'answers', name), 'utf8')).not.toMatch(/localSettings|userSettings|projectSettings|settings\.json/)
    }
  })
})

// ---- Phase 5: the changes panel, thinking, turn summaries, wild rows, link previews

const requireCjs = createRequire(import.meta.url)
const { checkLine, quickSkip } = requireCjs('../electron/chatSchema.cjs')

type Line = Record<string, any>
type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }
const jsonl = (name: string): Line[] => parsed(join(DIR, name)).map(p => p.value as Line)
const blocksOf = (l: Line, type: string): any[] => (Array.isArray(l.message?.content) ? l.message.content.filter((b: any) => b?.type === type) : [])
const CWD = 'C:\\Users\\user\\work\\demo'

/** A structuredPatch applied to a file's text: every context and removed line must be where the hunk says */
function applyPatch(text: string, hunks: Hunk[], where: string): string {
  const lines = text.split('\n')
  let shift = 0
  for (const h of hunks) {
    expect(h.oldLines, where).toBe(h.lines.filter(l => !l.startsWith('+')).length)
    expect(h.newLines, where).toBe(h.lines.filter(l => !l.startsWith('-')).length)
    expect(h.newStart, where).toBe(h.oldStart + shift)
    const old = h.lines.filter(l => !l.startsWith('+')).map(l => l.slice(1))
    const neu = h.lines.filter(l => !l.startsWith('-')).map(l => l.slice(1))
    expect(lines.slice(h.oldStart - 1 + shift, h.oldStart - 1 + shift + old.length), where).toEqual(old)
    lines.splice(h.oldStart - 1 + shift, old.length, ...neu)
    shift += neu.length - old.length
  }
  return lines.join('\n')
}

/** What a binary fixture's header says (the test's own small reader, so the listed sizes are checked) */
function headerOf(b: Buffer): { type: string; width?: number; height?: number } {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.toString('latin1', 12, 16) === 'IHDR') {
    return { type: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  }
  if (/^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return { type: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length && b[i] === 0xff;) {
      if (b[i + 1] === 0xc0 || b[i + 1] === 0xc2) return { type: 'jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
      i += 2 + b.readUInt16BE(i + 2)
    }
  }
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 16) === 'WEBPVP8L' && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21)
    return { type: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (/^<!doctype html/i.test(b.toString('latin1', 0, 15))) return { type: 'html' }
  return { type: 'unknown' }
}
/** The PNG chunk types in order */
function pngChunks(b: Buffer): string[] {
  const out: string[] = []
  for (let i = 8; i + 8 <= b.length; i += 12 + b.readUInt32BE(i)) out.push(b.toString('latin1', i + 4, i + 8))
  return out
}

describe('the Phase 5 fixtures', () => {
  const P5 = ['changes.jsonl', 'changes-agent/subagents/agent-afixture02.jsonl', 'changes-agent/subagents/agent-afixture02.meta.json',
    'thinking.jsonl', 'turns.jsonl', 'dex-events.json',
    'preview/og-basic.html', 'preview/og-entities.html', 'preview/og-euckr.html', 'preview/og-late.html', 'preview/og-script.html', 'preview/og-bidi.html',
    ...Object.keys(BINARIES)]

  it('exist', () => {
    for (const name of P5) expect(FILES.map(rel), name).toContain(name)
  })

  it('the binaries: exactly the listed ones, each with its SHA-256 and the size its header declares', () => {
    expect(FILES.filter(isBinary).map(rel).sort()).toEqual(Object.keys(BINARIES).sort())
    for (const [name, want] of Object.entries(BINARIES)) {
      const bytes = readFileSync(join(DIR, name))
      expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(want.sha256)
      expect(headerOf(bytes), name).toEqual({ type: want.type, width: want.width, height: want.height })
    }
    const chunks = (name: string) => pngChunks(readFileSync(join(DIR, 'preview', name)))
    expect(chunks('tiny.png')).toEqual(['IHDR', 'IDAT', 'IEND'])
    expect(chunks('anim.png')).toEqual(['IHDR', 'acTL', 'fcTL', 'IDAT', 'IEND']) // animated: acTL before the image data
    expect(chunks('huge-dims.png')).toEqual(['IHDR', 'IDAT'])                    // a header and a few bytes, nothing more
    expect(readFileSync(join(DIR, 'preview', 'huge-dims.png')).length).toBeLessThan(100)
  })

  it('every transcript line has the shape the lens checks (noise aside)', () => {
    for (const name of ['changes.jsonl', 'changes-agent/subagents/agent-afixture02.jsonl', 'thinking.jsonl', 'turns.jsonl']) {
      const raw = readFileSync(join(DIR, name), 'utf8').split('\n').filter(l => l.trim())
      let last = 0
      for (const l of raw) {
        if (quickSkip(l)) continue
        const obj = JSON.parse(l)
        expect(checkLine(obj), `${name}: ${l.slice(0, 80)}`).toBeNull()
        // in time order
        if (typeof obj.timestamp === 'string') { expect(Date.parse(obj.timestamp), `${name}: ${obj.uuid}`).toBeGreaterThanOrEqual(last); last = Date.parse(obj.timestamp) }
      }
    }
  })

  it('changes.jsonl: every kind of edit the changes panel must tell apart, in the real shapes', () => {
    const lines = jsonl('changes.jsonl')
    const calls = new Map(lines.flatMap(l => blocksOf(l, 'tool_use')).map(b => [b.id, b]))
    const results = new Map(lines.flatMap(l => blocksOf(l, 'tool_result').map(b => [b.tool_use_id, { block: b, r: l.toolUseResult, line: l }])))
    for (const id of results.keys()) expect(calls.has(id), id).toBe(true) // every result answers a call made before it
    const call = (id: string) => calls.get(id)
    const res = (id: string) => results.get(id)!
    const file = (rest: string) => `${CWD}\\${rest}`
    expect([...calls.keys()]).toEqual(['toolu_fixture_c01', 'toolu_fixture_c02', 'toolu_fixture_c03', 'toolu_fixture_c04', 'toolu_fixture_c05', 'toolu_fixture_c06',
      'toolu_fixture_c07', 'toolu_fixture_c08', 'toolu_fixture_c09', 'toolu_fixture_c10', 'toolu_fixture_c11', 'toolu_fixture_c12'])
    // three Edits of src/math.js with a patch (the second: two hunks 30 lines apart, a replace_all)
    for (const id of ['toolu_fixture_c01', 'toolu_fixture_c02', 'toolu_fixture_c12']) {
      expect(call(id)).toMatchObject({ name: 'Edit', input: { file_path: file('src\\math.js') } })
      expect(res(id).r.structuredPatch.length, id).toBeGreaterThan(0)
    }
    const two = res('toolu_fixture_c02').r.structuredPatch as Hunk[]
    expect(two).toHaveLength(2)
    expect(two[1].oldStart - (two[0].oldStart + two[0].oldLines)).toBeGreaterThanOrEqual(30)
    expect(call('toolu_fixture_c02').input.replace_all).toBe(true)
    // a Write that made src/util.js; a Write over README.md with its patch
    expect(call('toolu_fixture_c03')).toMatchObject({ name: 'Write', input: { file_path: file('src\\util.js') } })
    expect(res('toolu_fixture_c03').r).toMatchObject({ type: 'create', filePath: file('src\\util.js'), structuredPatch: [], originalFile: null })
    expect(call('toolu_fixture_c04')).toMatchObject({ name: 'Write', input: { file_path: file('README.md') } })
    expect(res('toolu_fixture_c04').r).toMatchObject({ type: 'update', filePath: file('README.md') })
    expect(applyPatch(res('toolu_fixture_c04').r.originalFile, res('toolu_fixture_c04').r.structuredPatch, 'README.md')).toBe(res('toolu_fixture_c04').r.content)
    // an Edit whose result holds no patch (and no type): missing
    expect(call('toolu_fixture_c05').name).toBe('Edit')
    expect(res('toolu_fixture_c05').r.filePath).toBe(file('src\\config.js'))
    expect('structuredPatch' in res('toolu_fixture_c05').r || 'type' in res('toolu_fixture_c05').r).toBe(false)
    // an Edit whose new line is 5,000 characters (cut by the diff's line cap)
    const long = (res('toolu_fixture_c06').r.structuredPatch as Hunk[]).flatMap(h => h.lines).filter(l => l.startsWith('+'))
    expect(long.map(l => l.length - 1)).toContain(5000)
    // a failed Edit and a rejected one: nothing changed
    expect(res('toolu_fixture_c07').block.is_error).toBe(true)
    expect(typeof res('toolu_fixture_c07').r).toBe('string')
    expect(res('toolu_fixture_c08').r).toBe('User rejected tool use')
    expect(res('toolu_fixture_c08').line.toolDenialKind).toBe('user-rejected')
    // an Edit of a file outside the session folder
    expect(res('toolu_fixture_c09').r.filePath).toBe('C:\\Users\\user\\other\\x.txt')
    expect(res('toolu_fixture_c09').r.structuredPatch.length).toBe(1)
    // a NotebookEdit whose result holds no patch
    expect(call('toolu_fixture_c10').name).toBe('NotebookEdit')
    expect(JSON.stringify(res('toolu_fixture_c10').r)).not.toMatch(/structuredPatch|"filePath"/)
    // the Agent that made its own edit (changes-agent/subagents/agent-afixture02.jsonl)
    expect(call('toolu_fixture_c11').name).toBe('Agent')
    expect(res('toolu_fixture_c11').r.agentId).toBe('afixture02')
    expect(lines.filter(l => l.type === 'system' && l.subtype === 'turn_duration')).toHaveLength(2)
  })

  it('changes.jsonl + the sub-agent: src/math.js edit after edit, each patch starting from what the one before left', () => {
    const main = jsonl('changes.jsonl')
    const agent = jsonl('changes-agent/subagents/agent-afixture02.jsonl')
    expect(agent.every(l => !('uuid' in l) || (l.isSidechain === true && l.agentId === 'afixture02'))).toBe(true)
    const agentEdits = agent.filter(l => l.toolUseResult?.structuredPatch)
    expect(agentEdits.map(l => blocksOf(l, 'tool_result')[0].tool_use_id)).toEqual(['toolu_fixture_ca1'])
    const math = [...main, ...agent]
      .filter(l => l.toolUseResult?.filePath === `${CWD}\\src\\math.js` && Array.isArray(l.toolUseResult.structuredPatch))
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    expect(math.map(l => blocksOf(l, 'tool_result')[0].tool_use_id)).toEqual(['toolu_fixture_c01', 'toolu_fixture_c02', 'toolu_fixture_ca1', 'toolu_fixture_c12'])
    let text: string = math[0].toolUseResult.originalFile
    for (const l of math) {
      expect(l.toolUseResult.originalFile, l.uuid).toBe(text)
      text = applyPatch(text, l.toolUseResult.structuredPatch, l.uuid)
    }
    // the agent's edit falls between the Agent call and the next main edit
    const at = (id: string) => Date.parse(main.find(l => blocksOf(l, 'tool_use').some(b => b.id === id))!.timestamp)
    expect(Date.parse(agentEdits[0].timestamp)).toBeGreaterThan(at('toolu_fixture_c11'))
    expect(Date.parse(agentEdits[0].timestamp)).toBeLessThan(at('toolu_fixture_c12'))
  })

  it('thinking.jsonl: empty thinking with its duration, a redacted block, one with text; each followed by text of the same message', () => {
    const lines = jsonl('thinking.jsonl').filter(l => l.type === 'assistant')
    const thinking = lines.filter(l => blocksOf(l, 'thinking').length || blocksOf(l, 'redacted_thinking').length)
    expect(thinking.length).toBeGreaterThanOrEqual(4)
    const empty = thinking.filter(l => blocksOf(l, 'thinking')[0]?.thinking === '')
    expect(empty.length).toBeGreaterThanOrEqual(2)
    for (const l of empty) expect(Number.isFinite(l.thinkingDurationMs)).toBe(true)
    expect(thinking.filter(l => blocksOf(l, 'redacted_thinking').length)).toHaveLength(1)
    expect(thinking.filter(l => (blocksOf(l, 'thinking')[0]?.thinking ?? '') !== '')).toHaveLength(1)
    for (const l of thinking) {
      expect(l.message.content).toHaveLength(1) // one line per content block
      const next = lines[lines.indexOf(l) + 1]
      expect(blocksOf(next, 'text').length, l.uuid).toBe(1)
      expect(next.message.id, l.uuid).toBe(l.message.id)
    }
  })

  it('turns.jsonl: two whole turns, a third one interrupted, a queued prompt taken mid-turn', () => {
    const lines = jsonl('turns.jsonl')
    const prompts = lines.filter(l => l.type === 'user' && typeof l.message?.content === 'string')
    const ends = lines.filter(l => l.type === 'system' && l.subtype === 'turn_duration')
    expect(prompts).toHaveLength(3)
    expect(ends).toHaveLength(2)
    const idx = (l: Line) => lines.indexOf(l)
    // turn 1 and 2 end in a turn_duration; turn 3 does not
    expect(idx(ends[0])).toBeGreaterThan(idx(prompts[0]))
    expect(idx(ends[0])).toBeLessThan(idx(prompts[1]))
    expect(idx(ends[1])).toBeGreaterThan(idx(prompts[1]))
    expect(idx(ends[1])).toBeLessThan(idx(prompts[2]))
    expect(lines.at(-1)!.message.content[0].text).toBe('[Request interrupted by user]')
    // the queued prompt is taken inside turn 2
    const queued = lines.find(l => l.type === 'attachment' && l.attachment?.type === 'queued_command')!
    expect(queued.attachment).toMatchObject({ commandMode: 'prompt', origin: { kind: 'human' } })
    expect(idx(queued)).toBeGreaterThan(idx(prompts[1]))
    expect(idx(queued)).toBeLessThan(idx(ends[1]))
    // each whole turn has tools and text; turn 2 changed two files
    for (const [from, to] of [[prompts[0], ends[0]], [prompts[1], ends[1]]]) {
      const turn = lines.slice(idx(from), idx(to))
      expect(turn.flatMap(l => blocksOf(l, 'tool_use')).length).toBeGreaterThanOrEqual(2)
      expect(turn.flatMap(l => blocksOf(l, 'text')).length).toBeGreaterThanOrEqual(1)
    }
    const files = (from: Line, to: Line) => new Set(lines.slice(idx(from), idx(to)).filter(l => l.toolUseResult?.filePath && (l.toolUseResult.structuredPatch?.length || l.toolUseResult.type === 'create')).map(l => l.toolUseResult.filePath))
    expect(files(prompts[0], ends[0]).size).toBe(1)
    expect(files(prompts[1], ends[1]).size).toBe(2)
  })

  it('dex-events.json: a DexState log and today in the server\'s event shape; no prompt text; times before, inside and after turns.jsonl', () => {
    const dex = JSON.parse(readFileSync(join(DIR, 'dex-events.json'), 'utf8'))
    const events: Line[] = [...dex.log, ...dex.today]
    const KEYS = new Set(['kind', 'id', 'name', 'tier', 'shiny', 'place', 'sessionId', 'pity', 'attendance', 'toProfessor', 'level', 'newSpecies', 'via', 'ball', 'gender', 'nature', 'from', 'fromName', 'uid', 'partner', 'at'])
    for (const e of events) {
      for (const k of Object.keys(e)) expect(KEYS.has(k), k).toBe(true)
      expect(typeof e.at).toBe('number')
      expect(typeof e.id).toBe('number')
      if ('via' in e && e.via !== null) expect(e.via.prompt).toBeNull()
    }
    // log keeps the bookkeeping kinds out (server LOG_HIDDEN); today has them
    expect(dex.log.some((e: Line) => e.kind === 'sendout')).toBe(false)
    expect(dex.today.some((e: Line) => e.kind === 'sendout')).toBe(true)
    const of = (kind: string, sessionId: string) => events.filter(e => e.kind === kind && e.sessionId === sessionId)
    expect(of('catch', 's-1').some(e => e.newSpecies === true && e.ball === 'great-ball' && e.level === 6)).toBe(true)
    expect(of('flee', 's-1').length).toBeGreaterThan(0)
    expect(of('catch', 's-2').length).toBeGreaterThan(0)
    expect(of('levelup', 's-1').length).toBeGreaterThan(0)
    expect(of('evolve', 's-1').length).toBeGreaterThan(0)
    expect(events.some(e => e.kind === 'catch' && e.attendance === true)).toBe(true)
    const times = jsonl('turns.jsonl').filter(l => typeof l.timestamp === 'string').map(l => Date.parse(l.timestamp))
    const first = Math.min(...times)
    const last = Math.max(...times)
    const where = (at: number) => (at < first ? 'before' : at > last ? 'after' : 'inside')
    const met = [...of('catch', 's-1'), ...of('flee', 's-1')]
    expect(new Set(met.map(e => where(e.at)))).toEqual(new Set(['before', 'inside', 'after']))
    for (const e of met) expect(times, `${e.kind} ${e.at}`).not.toContain(e.at) // never at the same moment as a line
  })

  it('the pages: og tags in the shapes the meta reader must handle', () => {
    const page = (name: string) => readFileSync(join(DIR, 'preview', name))
    const basic = page('og-basic.html').toString('utf8')
    for (const tag of ['og:title', 'og:description', 'og:site_name', 'og:image', 'twitter:title', 'twitter:description', 'twitter:image']) expect(basic).toContain(`"${tag}"`)
    const entities = page('og-entities.html').toString('utf8')
    for (const s of ['&amp;', '&#39;', '&#x2014;', '&quot;', '<META PROPERTY=og:title', "CONTENT='"]) expect(entities).toContain(s)
    // EUC-KR bytes (not UTF-8), the charset named in a meta
    const euckr = page('og-euckr.html')
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(euckr)).toThrow()
    expect(textOf(join(DIR, 'preview', 'og-euckr.html'))).toContain('한강의 다리')
    expect(euckr.toString('latin1')).toMatch(/<meta charset="?euc-kr"?>/i)
    // og-late: more than 600 KB of head before the og tags; a <title> before the cap
    const late = page('og-late.html').toString('utf8')
    expect(late.indexOf('og:title')).toBeGreaterThan(600 * 1024)
    expect(late.indexOf('<title>')).toBeLessThan(512 * 1024)
    expect(late.indexOf('</head>')).toBeGreaterThan(late.indexOf('og:title'))
    // og-script: og tags inside a script, a comment, a style, noscript and a template, then the real ones
    const script = page('og-script.html').toString('utf8')
    expect(script.match(/og:title/g)!.length).toBeGreaterThanOrEqual(3)
    expect(script).toMatch(/<!--[^>]*og:title[\s\S]*-->/)
    expect(script).toMatch(/<script[^>]*>[\s\S]*og:[\s\S]*<\/script>/)
    // og-bidi: a right-to-left override and zero-width characters in the title
    const bidi = page('og-bidi.html').toString('utf8')
    expect(bidi).toContain('\u202e')
    expect(bidi).toMatch(/[\u200b\u200c\u200d\ufeff]/)
  })
})

// review M19: allowlists, not only the owner's known strings; and the chat tests' own sources
const SYNTHETIC_UUID = /^(00000000-0000-4000-8000-[0-9a-f]{12}|([0-9a-f])\2{7}-\2{4}-4\2{3}-8\2{3}-\2{12})$/
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const IDS = /\b(msg|toolu|req)_[A-Za-z0-9]+/g

/** What is wrong with a fixture's string value (an empty list: nothing) */
function fixtureProblems(value: string): string[] {
  const out: string[] = []
  for (const m of value.matchAll(UUID_ANY)) if (!/^00000000-0000-4000-8000-[0-9a-f]{12}$/.test(m[0])) out.push(`uuid ${m[0]}`)
  for (const m of value.matchAll(IDS)) if (!m[0].includes('fixture')) out.push(`id ${m[0]}`)
  if (/^\\\\[^\\\s]+\\/.test(value) || /[\s"']\\\\[^\\\s]+\\/.test(value)) out.push('a UNC path')
  if (/\/mnt\/[a-z]\//.test(value)) out.push('a WSL path')
  if (/(^|[\s"'(])~\//.test(value)) out.push('a ~/ path')
  return out
}

/** What is wrong with a chat test's source text */
function sourceProblems(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(UUID_ANY)) if (!SYNTHETIC_UUID.test(m[0])) out.push(`uuid ${m[0]}`)
  for (const m of text.matchAll(/\b(msg|toolu|req)_01[A-Za-z0-9]{6,}/g)) out.push(`id ${m[0]}`)
  if (/DueStar|spawn-promo|chat-spike|sk-ant-|Bearer [A-Za-z0-9]/i.test(text)) out.push('a known private string')
  if (/\/mnt\/[a-z]\/Users/.test(text)) out.push('a WSL home path')
  out.push(...privateHits(text))
  return out
}

/** The repository's own text files under these folders (dot-folders, node_modules and dist skipped) */
const TEXT = /\.(ts|tsx|cjs|mjs|js|json|jsonl|md|css|html|txt)$/
function textFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name.startsWith('.') || name === 'node_modules' || name === 'dist') return []
    const p = join(dir, name)
    return statSync(p).isDirectory() ? textFiles(p) : TEXT.test(name) ? [p] : []
  })
}

describe('the allowlists (review M19)', () => {
  it('catch what the denylist did not: real-looking uuids and ids, UNC, WSL and ~/ paths', () => {
    // (a made-up uuid of the real kind; no real one is ever written here)
    expect(fixtureProblems('4f1c2a9e-7b3d-4e8a-9c5f-1a2b3c4d5e6f')).toEqual(['uuid 4f1c2a9e-7b3d-4e8a-9c5f-1a2b3c4d5e6f'])
    expect(fixtureProblems('msg_01AbCdEf toolu_fixture01 req_0123')).toEqual(['id msg_01AbCdEf', 'id req_0123'])
    expect(fixtureProblems('\\\\fileserver\\share\\x.jsonl')).toEqual(['a UNC path'])
    expect(fixtureProblems('/mnt/c/Users/someone/x')).toEqual(['a WSL path'])
    expect(fixtureProblems('see ~/notes.txt')).toEqual(['a ~/ path'])
    expect(fixtureProblems('C:\\Users\\user\\work\\demo 00000000-0000-4000-8000-000000000101 toolu_fixture07')).toEqual([])
    expect(sourceProblems("const id = '4f1c2a9e-7b3d-4e8a-9c5f-1a2b3c4d5e6f'")).toHaveLength(1)
    expect(sourceProblems("const T1 = '11111111-1111-4111-8111-111111111111'")).toEqual([])
  })

  it('every string value of every fixture passes', () => {
    for (const file of TEXTS) {
      for (const { value } of parsed(file).flatMap(p => strings(p.value))) expect(fixtureProblems(value), `${rel(file)}: ${value.slice(0, 60)}`).toEqual([])
    }
  })

  it('the chat tests\' own sources pass too (this guard aside: it names the public strings it looks for)', () => {
    const dir = join(__dirname)
    const sources = readdirSync(dir).filter(n => /^chat-.*\.ts$/.test(n) && n !== 'chat-fixtures.test.ts')
    expect(sources).toContain('chat-helpers.ts')
    for (const n of sources) expect(sourceProblems(readFileSync(join(dir, n), 'utf8')), n).toEqual([])
  })
})

describe('no private value in the repository (re-review m-13)', () => {
  it('the guard catches an owner\'s name and a listed hex string, built here from made-up parts', () => {
    // never a real value: a made-up name and a made-up 16-digit hex string, and the hash of the latter
    const owner = ['zq', 'w', '7x'].join('')
    const hex = Array.from({ length: 16 }, (_, i) => '0123456789abcdef'[(i * 7 + 3) % 16]).join('')
    const secrets = { owners: [owner], digests: new Set([sha256(hex)]) }
    expect(privateHits(`C:\\Users\\${owner}\\work\\a.ts`, secrets)).toEqual(['the machine owner\'s name'])
    expect(privateHits(`/Users/${owner.toUpperCase()}/a`, secrets)).toEqual(['the machine owner\'s name'])
    expect(privateHits(`${owner}9 and x${owner}`, secrets)).toEqual([]) // only as a word
    expect(privateHits(`id ${hex} here`, secrets)).toEqual(['a private hex string'])
    expect(privateHits(`id ${hex.toUpperCase()} here`, secrets)).toEqual(['a private hex string'])
    expect(privateHits(`id ${hex}0 is longer`, secrets)).toEqual([])
    // generic account names are not a machine owner's
    expect(GENERIC_NAMES.has('runner') && GENERIC_NAMES.has('user')).toBe(true)
    // the real list holds only hashes (64 hex digits), never a value
    for (const d of PRIVATE_DIGESTS) expect(d).toMatch(/^[0-9a-f]{64}$/)
  })

  it('no fixture, test, source or plan names the machine owner or a listed private string (this file included)', () => {
    const root = join(__dirname, '..')
    const files = ['tests', 'electron', 'src', 'server', 'hooks', 'scripts', join('docs', 'superpowers')].flatMap(d => textFiles(join(root, d)))
    expect(files.length).toBeGreaterThan(100)
    const hits = files.flatMap(f => privateHits(readFileSync(f, 'utf8')).map(h => `${relative(root, f)}: ${h}`))
    expect(hits).toEqual([])
  })
})
