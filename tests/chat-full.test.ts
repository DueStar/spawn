/**
 * "전체 보기": an item read again whole from its transcript line — an answer, a user message, a
 * thinking block, a tool's output (found after its call), a `!` command's output; a Read's text never.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { readFull, lineAt } = require('../electron/chatFull.cjs')

const dir = mkdtempSync(join(tmpdir(), 'spawn-chat-full-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const long = 'x'.repeat(300_000)
const lines = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: `질문 ${long}` } },
  { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '생각' }, { type: 'text', text: `# 답\n${long}` }] } },
  { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n') }] } },
  { type: 'user', uuid: 'u3', message: { role: 'user', content: '<bash-input>git log</bash-input>' } },
  { type: 'user', uuid: 'u4', message: { role: 'user', content: '<bash-stdout>commit 1\n&lt;tag&gt;</bash-stdout><bash-stderr></bash-stderr>' } },
]
const text = lines.map(l => JSON.stringify(l)).join('\n') + '\n'
const file = join(dir, 's.jsonl')
writeFileSync(file, text)
const offsets: number[] = []
{ let at = 0; for (const l of lines) { offsets.push(at); at += Buffer.byteLength(JSON.stringify(l)) + 1 } }

describe('readFull', () => {
  it('a user message and an answer, whole', async () => {
    const u = await readFull(fs.promises, file, { id: 'u1', kind: 'user', order: offsets[0] })
    expect(u).toMatchObject({ ok: true, md: false, truncated: false })
    expect(u.text.length).toBe(300_003)
    const a = await readFull(fs.promises, file, { id: 'a1:1', kind: 'text', order: offsets[1] + 1 / 1024 })
    expect(a).toMatchObject({ ok: true, md: true })
    expect(a.text.startsWith('# 답\nxxx')).toBe(true)
    expect(await readFull(fs.promises, file, { id: 'a1:0', kind: 'thinking', order: offsets[1] })).toMatchObject({ ok: true, text: '생각' })
  })
  it('a tool\'s output from its result line; a Read never', async () => {
    const r = await readFull(fs.promises, file, { id: 'toolu_1', kind: 'tool', tool: 'Bash', order: offsets[2] })
    expect(r.ok).toBe(true)
    expect(r.text.split('\n')).toHaveLength(500)
    expect(await readFull(fs.promises, file, { id: 'toolu_1', kind: 'tool', tool: 'Read', order: offsets[2] })).toEqual({ ok: false, reason: 'none' })
  })
  it('a ! command\'s output, unescaped', async () => {
    expect(await readFull(fs.promises, file, { id: 'u3', kind: 'shell', order: offsets[4] })).toMatchObject({ ok: true, text: 'commit 1\n<tag>' })
  })
  it('an offset past the end, a sub-agent\'s item, an unknown kind: not read', async () => {
    expect((await readFull(fs.promises, file, { id: 'z', kind: 'text', order: Buffer.byteLength(text) + 10 })).ok).toBe(false)
    expect((await readFull(fs.promises, file, { id: 'z', kind: 'text', order: 0, parent: 'toolu_9' })).ok).toBe(false)
    expect((await readFull(fs.promises, file, { id: 'z', kind: 'notice', order: 0 })).ok).toBe(false)
    expect(await lineAt(fs.promises, file, Buffer.byteLength(text))).toBeNull()
  })
})
