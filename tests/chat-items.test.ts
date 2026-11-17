/**
 * electron/chatItems.cjs — transcript lines become conversation items: user
 * messages, prose, tool rows (paired with their results, also across pages),
 * notices and turn ends; tool input whitelisted, tool output capped.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { itemProblems, linesOf } from './chat-helpers'

const require = createRequire(import.meta.url)
const { createItemBuilder, toolInput, toolOutput, CAPS } = require('../electron/chatItems.cjs')
const { quickSkip } = require('../electron/chatSchema.cjs')

const CWD = 'C:\\Users\\user\\work\\demo'

/** Feed a fixture through one builder; the items by id (a later version of an item wins) */
function build(name: string, opts: Record<string, unknown> = { cwd: CWD }) {
  const b = createItemBuilder(opts)
  const items = new Map<string, any>()
  for (const { text, offset } of linesOf(name)) {
    if (quickSkip(text)) continue
    let obj
    try { obj = JSON.parse(text) } catch { continue }
    for (const it of b.line(obj, offset)) items.set(it.id, it)
  }
  return { b, items: [...items.values()] }
}
const kinds = (items: any[]) => items.map(i => i.kind)
const toolById = (items: any[], id: string) => items.find(i => i.id === id)

describe('basic.jsonl', () => {
  it('one user message, its (empty) thinking, one answer with the table, one turn end of 13909 ms; nothing from the bookkeeping', () => {
    const { items } = build('basic.jsonl')
    // (Phase 5: the thinking block is an item too; the 기본 density draws no row for it)
    expect(kinds(items)).toEqual(['user', 'thinking', 'text', 'turn-end'])
    expect(items[0].text).toMatch(/^Without using any tools/)
    expect(items[0].images).toBe(0)
    expect(items[1]).toMatchObject({ kind: 'thinking', text: '', durationMs: 800 })
    expect(items[2].text).toContain('| α | alpha |')
    expect(items[2].partial).toBeUndefined()
    expect(items[3].durationMs).toBe(13909)
    expect(items[0].at).toBe(Date.parse('2026-11-13T08:40:00.000Z'))
    const json = JSON.stringify(items)
    for (const word of ['REDACTED', 'credential', 'base64']) expect(json).not.toContain(word)
  })

  it('items are ordered by their line\'s byte offset', () => {
    const { items } = build('basic.jsonl')
    const lines = linesOf('basic.jsonl')
    const userLine = lines.find(l => l.text.includes('"type":"user"'))!
    expect(items[0].order).toBe(userLine.offset)
    expect(items[1].order).toBeGreaterThan(items[0].order)
  })
})

describe('tools.jsonl', () => {
  const { items } = build('tools.jsonl')

  it('a Read row, done, with the file relative to the session folder and no file text', () => {
    const read = toolById(items, 'toolu_fixture01')
    expect(read).toMatchObject({ kind: 'tool', tool: 'Read', state: 'done', input: { file: 'src/math.js' } })
    expect(read.output).toEqual({ text: '', lines: 10, truncated: false, error: false })
  })

  it('Grep and Glob rows', () => {
    expect(toolById(items, 'toolu_fixture02')).toMatchObject({ tool: 'Grep', state: 'done', input: { pattern: 'sub', path: 'src' } })
    expect(toolById(items, 'toolu_fixture03')).toMatchObject({ tool: 'Glob', state: 'done', input: { pattern: 'src/**/*.js' } })
  })

  it('Bash: done with its output, and a failed one marked failed', () => {
    const ok = toolById(items, 'toolu_fixture04')
    expect(ok).toMatchObject({ tool: 'Bash', state: 'done', input: { command: 'node -e "console.log(6*7)"', description: 'Run node to print 6*7' } })
    expect(ok.output).toEqual({ text: '42', lines: 1, truncated: false, error: false })
    const bad = toolById(items, 'toolu_fixture05')
    expect(bad.state).toBe('failed')
    expect(bad.output.error).toBe(true)
    expect(bad.output.text).toContain('Cannot find module')
  })

  it('the first Edit failed, the second is done; Write is done', () => {
    expect(toolById(items, 'toolu_fixture06').state).toBe('failed')
    expect(toolById(items, 'toolu_fixture07')).toMatchObject({ tool: 'Edit', state: 'done', input: { file: 'src/math.js' } })
    expect(toolById(items, 'toolu_fixture08')).toMatchObject({ tool: 'Write', state: 'done', input: { file: 'src/notes.md' } })
  })

  it('the whole tool input never travels: no old/new strings, no file content', () => {
    const json = JSON.stringify(items)
    // no edit strings in a row's input (the diff block of Task 5 shows the change instead)
    for (const it of items.filter(i => i.kind === 'tool')) expect(JSON.stringify(it.input)).not.toContain('module.exports')
    expect(json).not.toContain('old_string')
    expect(json).not.toContain('originalFile')
    expect(Object.keys(toolById(items, 'toolu_fixture08').input)).toEqual(['file'])
  })

  it('the final answer and the turn end', () => {
    expect(items.filter(i => i.kind === 'text')).toHaveLength(1)
    expect(items.filter(i => i.kind === 'turn-end')).toHaveLength(1)
    expect(items.filter(i => i.kind === 'user')).toHaveLength(1)
  })
})

describe('interrupt.jsonl', () => {
  it('a partial answer, the interruptions as notices, the rejected tool', () => {
    const { items } = build('interrupt.jsonl')
    const text = items.find(i => i.kind === 'text')
    expect(text.partial).toBe(true)
    const notices = items.filter(i => i.kind === 'notice')
    expect(notices.map(n => n.notice)).toEqual(['interrupted', 'interrupted'])
    expect(toolById(items, 'toolu_fixture31').state).toBe('rejected')
  })
})

describe('commands.jsonl', () => {
  it('a /clear notice; nothing from the queue line, the command output or the reminder', () => {
    const { items } = build('commands.jsonl')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'notice', notice: 'command', text: '/clear' })
  })
})

describe('image.jsonl', () => {
  it('the user message counts its image; the picture itself is never copied', () => {
    const { items } = build('image.jsonl')
    const user = items.filter(i => i.kind === 'user')
    expect(user).toHaveLength(1)
    expect(user[0].images).toBe(1)
    expect(user[0].text).toBe('[Image #1] What colour is this square?')
    expect(JSON.stringify(items)).not.toMatch(/iVBOR|base64/)
  })
})

describe('ask-plan.jsonl', () => {
  it('the question with its options, and the plan', () => {
    const { items } = build('ask-plan.jsonl')
    expect(toolById(items, 'toolu_fixture51')).toMatchObject({ tool: 'AskUserQuestion', state: 'done', input: { question: 'Should README.md be updated too?', options: ['Yes', 'No'] } })
    const plan = toolById(items, 'toolu_fixture53')
    expect(plan).toMatchObject({ tool: 'ExitPlanMode', state: 'rejected' })
    expect(plan.input.plan).toMatch(/^# Plan: rename notes.txt/)
    expect(toolById(items, 'toolu_fixture52').input.file).toBe('C:\\Users\\user\\.claude\\plans\\plan-demo-river.md')
    expect(JSON.stringify(items)).not.toContain('REDACTED')
  })
})

describe('agent.jsonl', () => {
  it('the Agent row carries its sub-agent and type; the task notification is a notice', () => {
    const { items } = build('agent.jsonl')
    expect(toolById(items, 'toolu_fixture41')).toMatchObject({ tool: 'Agent', state: 'done', agentId: 'afixture01', input: { description: 'Count lines in notes.txt', agentType: 'general-purpose' } })
    expect(items.filter(i => i.kind === 'notice').map(n => n.notice)).toEqual(['agent-done'])
  })

  it('a sub-agent\'s lines are skipped by the main builder, and built under their Agent row by one made for them', () => {
    expect(build('agent/subagents/agent-afixture01.jsonl').items).toEqual([])
    const { items } = build('agent/subagents/agent-afixture01.jsonl', { cwd: CWD, parent: 'toolu_fixture41' })
    expect(kinds(items)).toEqual(['tool', 'text'])
    expect(items.every(i => i.parent === 'toolu_fixture41')).toBe(true)
    expect(items[0]).toMatchObject({ tool: 'PowerShell', state: 'done', output: { text: '3' } })
  })
})

describe('pairing across pages', () => {
  it('a result read before its call makes one row, which takes the call\'s place and name when the call arrives', () => {
    const lines = linesOf('tools.jsonl')
    const call = lines.find(l => l.text.includes('"id":"toolu_fixture04"'))!
    const result = lines.find(l => l.text.includes('"tool_use_id":"toolu_fixture04"'))!
    const b = createItemBuilder({ cwd: CWD })
    const first = b.line(JSON.parse(result.text), result.offset)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ id: 'toolu_fixture04', tool: null, state: 'done', order: result.offset })
    const second = b.line(JSON.parse(call.text), call.offset)
    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({ id: 'toolu_fixture04', tool: 'Bash', state: 'done', order: call.offset, input: { command: 'node -e "console.log(6*7)"' } })
    expect(second[0].output.text).toBe('42')
    expect(b.tool('toolu_fixture04').tool).toBe('Bash')
  })
})

describe('caps', () => {
  it('a 1 MB command output becomes at most 8000 characters, says it was cut and how many lines there were', () => {
    const big = Array.from({ length: 50_000 }, (_, i) => `line ${i} ${'x'.repeat(14)}`).join('\n') // ~1.1 MB
    const b = createItemBuilder({ cwd: CWD })
    b.line({ type: 'assistant', uuid: 'a', timestamp: '2026-11-13T00:00:00Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat big' } }], stop_reason: 'tool_use' } }, 0)
    const [item] = b.line({ type: 'user', uuid: 'b', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: big, is_error: false }] }, toolUseResult: { stdout: big, stderr: '' } }, 100)
    expect(item.output.text.length).toBeLessThanOrEqual(CAPS.output)
    expect(item.output.text.split('\n').length).toBeLessThanOrEqual(CAPS.outputLines)
    expect(item.output.truncated).toBe(true)
    expect(item.output.lines).toBe(50_000)
    expect(JSON.stringify(item).length).toBeLessThan(10_000)
  })

  it('a very long prompt and an endless command are cut too', () => {
    const b = createItemBuilder({ cwd: CWD })
    const [u] = b.line({ type: 'user', uuid: 'u', message: { content: 'y'.repeat(CAPS.text + 10) } }, 0)
    expect(u.text.length).toBe(CAPS.text)
    expect(u.truncated).toBe(true)
    expect(toolInput('Bash', { command: 'z'.repeat(5000), description: 'd'.repeat(1000) }, CWD).command.length).toBe(CAPS.command)
    expect(toolInput('Bash', { command: 'z', description: 'd'.repeat(1000) }, CWD).description.length).toBe(CAPS.field)
  })
})

describe('toolInput', () => {
  it('keeps only the whitelisted fields of each tool', () => {
    expect(toolInput('WebFetch', { url: 'https://example.com/a', prompt: 'secret instructions' })).toEqual({ url: 'https://example.com/a' })
    expect(toolInput('WebSearch', { query: 'rivers', allowed_domains: ['x'] })).toEqual({ query: 'rivers' })
    expect(toolInput('TodoWrite', { todos: [{ status: 'completed' }, { status: 'pending' }, { status: 'completed' }] })).toEqual({ todos: { done: 2, total: 3 } })
    expect(toolInput('mcp__figma__get_screenshot', { nodeId: '1:2' })).toEqual({ server: 'figma', mcpTool: 'get_screenshot' })
    expect(toolInput('SomethingNew', { anything: 'x' })).toEqual({})
    expect(toolInput('Read', { file_path: 'D:\\elsewhere\\x.ts' }, CWD)).toEqual({ file: 'D:\\elsewhere\\x.ts' })
    expect(toolInput('Read', { file_path: '/Users/user/work/demo/src/a.ts' }, '/Users/user/work/demo')).toEqual({ file: 'src/a.ts' })
    expect(toolInput('AskUserQuestion', { questions: [{ question: 'q?', options: Array.from({ length: 9 }, (_, i) => ({ label: `o${i}` })) }] }).options).toHaveLength(6)
    expect(toolInput('Read', null)).toEqual({})
  })

  it('toolOutput: text blocks joined; pictures never copied', () => {
    expect(toolOutput([{ type: 'text', text: 'a' }, { type: 'image', source: { data: 'iVBOR' } }, { type: 'text', text: 'b' }], {}, false)).toEqual({ text: 'a\nb', lines: 2, truncated: false, error: false })
  })
})

// Phase 5 (Task 5.5): thinking blocks become items (shown from 생각 포함); Claude Code 2.1.32x writes them empty
describe('thinking.jsonl', () => {
  const { items } = build('thinking.jsonl')
  const thinking = items.filter(i => i.kind === 'thinking')

  it('every thinking block is an item, in order before its answer: duration, empty text, redacted, and the one with text', () => {
    expect(kinds(items)).toEqual(['user', 'thinking', 'text', 'turn-end', 'user', 'thinking', 'text', 'turn-end', 'user', 'thinking', 'text', 'turn-end', 'user', 'thinking', 'text', 'turn-end'])
    expect(thinking.map(i => i.durationMs)).toEqual([1400, 900, 600, 2100])
    expect(thinking[0]).toEqual({ id: '00000000-0000-4000-8000-000000001303', order: thinking[0].order, at: Date.parse('2026-11-14T04:00:03.000Z'), kind: 'thinking', text: '', durationMs: 1400 })
    expect(thinking[1].text).toBe('')
    // a redacted block: no text, marked (its data never travels)
    expect(thinking[2]).toMatchObject({ kind: 'thinking', text: '', redacted: true, durationMs: 600 })
    expect(JSON.stringify(items)).not.toContain('fixture-redacted-thinking')
    // a later Claude Code that writes the thinking: its text is there
    expect(thinking[3].text).toMatch(/^The Amazon drains the largest basin on Earth/)
    expect(thinking[3].redacted).toBeUndefined()
    for (const it of items) expect(itemProblems(it), JSON.stringify(it).slice(0, 200)).toEqual([])
  })

  it('the text is capped as an answer is; a duration that is not a finite number ≥ 0 is left out; several blocks keep the line\'s block ids', () => {
    const b = createItemBuilder({ cwd: CWD, caps: { ...CAPS, text: 10 } })
    const [long] = b.line({ type: 'assistant', uuid: 'a', thinkingDurationMs: -5, message: { content: [{ type: 'thinking', thinking: 'x'.repeat(50) }], stop_reason: 'end_turn' } }, 0)
    expect(long).toEqual({ id: 'a', order: 0, at: null, kind: 'thinking', text: 'x'.repeat(10), truncated: true })
    const [nan] = b.line({ type: 'assistant', uuid: 'b', thinkingDurationMs: 'soon', message: { content: [{ type: 'thinking', thinking: 'ok' }], stop_reason: 'end_turn' } }, 10)
    expect(nan.durationMs).toBeUndefined()
    const both = b.line({ type: 'assistant', uuid: 'c', thinkingDurationMs: 300, message: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'hi' }], stop_reason: 'end_turn' } }, 20)
    expect(both.map(i => [i.id, i.kind])).toEqual([['c:0', 'thinking'], ['c:1', 'text']])
    // a thinking block with no string: empty text, never a guess
    const [odd] = b.line({ type: 'assistant', uuid: 'd', message: { content: [{ type: 'thinking' }], stop_reason: 'end_turn' } }, 30)
    expect(odd).toMatchObject({ kind: 'thinking', text: '' })
  })

  it('a sub-agent\'s thinking makes no item (its rows show only tools and its result)', () => {
    const b = createItemBuilder({ cwd: CWD, parent: 'toolu_x' })
    expect(b.line({ type: 'assistant', isSidechain: true, uuid: 'a', thinkingDurationMs: 300, message: { content: [{ type: 'thinking', thinking: '' }], stop_reason: 'end_turn' } }, 0)).toEqual([])
  })
})

describe('the event model', () => {
  it('every item from every fixture fits the field lists of src/chat/types.ts', () => {
    const all: any[] = []
    for (const name of ['basic.jsonl', 'tools.jsonl', 'interrupt.jsonl', 'agent.jsonl', 'ask-plan.jsonl', 'image.jsonl', 'commands.jsonl', 'bad.jsonl', 'mac/basic.jsonl', 'thinking.jsonl']) all.push(...build(name).items)
    all.push(...build('agent/subagents/agent-afixture01.jsonl', { cwd: CWD, parent: 'toolu_fixture41' }).items)
    expect(all.length).toBeGreaterThan(30)
    for (const it of all) expect(itemProblems(it), JSON.stringify(it).slice(0, 200)).toEqual([])
    // every kind the model names is one the checker knows (the field lists come from types.ts)
    const types = readFileSync(join(__dirname, '..', 'src', 'chat', 'types.ts'), 'utf8')
    const modelKinds = [...types.matchAll(/extends ItemBase \{\s*kind: '([a-z-]+)'/g)].map(m => m[1]).sort()
    expect(modelKinds).toEqual(['live', 'notice', 'shell', 'text', 'thinking', 'tool', 'turn-end', 'user'])
    for (const k of modelKinds) expect(itemProblems({ id: 'x', order: 0, at: null, kind: k }).some(p => p.startsWith('unknown kind'))).toBe(false)
  })

  it('bad.jsonl: an unknown block becomes a notice the page can show; nothing is guessed from a broken line', () => {
    const { items } = build('bad.jsonl')
    expect(items.map(i => i.kind === 'notice' ? i.notice : i.kind)).toEqual(['unknown-block'])
  })
})

// The review of Tasks 1–10 (review-1-10.md)
describe('review fixes', () => {
  const userLine = (text: string) => ({ type: 'user', uuid: 'u1', timestamp: '2026-11-14T12:00:00Z', message: { role: 'user', content: text } })

  it('M1: a prompt that only mentions a command tag stays the user\'s message', () => {
    const b = createItemBuilder({ cwd: CWD })
    const [it] = b.line(userLine('Why does my log show <command-name>/clear</command-name> twice?'), 0)
    expect(it).toMatchObject({ kind: 'user', text: 'Why does my log show <command-name>/clear</command-name> twice?' })
    const [cmd] = b.line(userLine('<command-name>/clear</command-name>\n<command-message>clear</command-message>'), 10)
    expect(cmd).toMatchObject({ kind: 'notice', notice: 'command', text: '/clear' })
    const [cmd2] = b.line(userLine('<command-message>compact</command-message>\n<command-name>/compact</command-name>'), 20)
    expect(cmd2).toMatchObject({ kind: 'notice', notice: 'command', text: '/compact' })
  })

  it('M6: a Bash result that says it was interrupted makes the row interrupted, not failed', () => {
    const b = createItemBuilder({ cwd: CWD })
    b.line({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 60' } }], stop_reason: 'tool_use' } }, 0)
    const [row] = b.line({ type: 'user', uuid: 'b', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Interrupted', is_error: true }] }, toolUseResult: { stdout: '', stderr: '', interrupted: true } }, 10)
    expect(row.state).toBe('interrupted')
  })

  it('M10: a Read row never carries the file\'s text, whatever the result looks like', () => {
    const b = createItemBuilder({ cwd: CWD })
    b.line({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${CWD}\\.env` } }], stop_reason: 'tool_use' } }, 0)
    const [row] = b.line({ type: 'user', uuid: 'b', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'API_KEY=secret\nOTHER=1' }] } }, 10)
    expect(row.output).toEqual({ text: '', lines: 2, truncated: false, error: false })
    // a result read before its call (an older page), then the call: still blank once it is known to be a Read
    const c = createItemBuilder({ cwd: CWD })
    c.line({ type: 'user', uuid: 'b', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'API_KEY=secret' }] } }, 10)
    const [known] = c.line({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'x' } }], stop_reason: 'tool_use' } }, 0)
    expect(known.output.text).toBe('')
    // a Read that failed shows its error
    const [err] = createItemBuilder({}).line({ type: 'user', uuid: 'c', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'File does not exist.', is_error: true }] } }, 5)
    expect(err.output.text).toBe('File does not exist.')
  })
})
