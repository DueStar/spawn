/**
 * electron/chatSchema.cjs — what a transcript line is, whether it has the
 * shape the chat lens relies on, which lines are skipped unparsed, and which
 * Claude Code versions the lens was checked against.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { quickSkip, classify, checkLine, versionVerdict, SUPPORTED, NOISE_TYPES, KEEP_ATTACHMENTS } = require('../electron/chatSchema.cjs')

const FIX = join(__dirname, 'fixtures', 'chat')
const lines = (name: string) => readFileSync(join(FIX, name), 'utf8').split('\n').filter(l => l.trim())

afterEach(() => { vi.restoreAllMocks() })

describe('noise is skipped without parsing', () => {
  it('every line of basic.jsonl classifies; the bookkeeping ones are skipped before any parse', () => {
    const raw = lines('basic.jsonl')
    const noise = raw.filter(l => quickSkip(l))
    const kept = raw.filter(l => !quickSkip(l))
    // mode, permission-mode, session-owner, atis-latch, file-history-snapshot, 5 attachments, 3 api-request*, last-prompt, ai-title
    expect(noise.length).toBe(15)
    const spy = vi.spyOn(JSON, 'parse')
    for (const l of noise) expect(quickSkip(l)).toBe(true)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
    for (const l of raw) expect(['user', 'assistant', 'system', 'attachment', 'noise']).toContain(classify(JSON.parse(l)))
    expect(kept.map(l => classify(JSON.parse(l)))).toEqual(['user', 'assistant', 'assistant', 'system', 'system'])
    for (const l of noise) expect(['noise', 'attachment']).toContain(classify(JSON.parse(l)))
  })

  it('knows the bookkeeping types, and keeps only the mid-turn prompt among the attachments', () => {
    for (const t of ['file-history-snapshot', 'queue-operation', 'last-prompt', 'ai-title', 'cost-state', 'mode', 'api-request-blob', 'summary', 'bridge-session']) expect(NOISE_TYPES).toContain(t)
    expect([...KEEP_ATTACHMENTS]).toEqual(['queued_command'])
    // (the composer's queue strip reads these; they are still noise for the conversation)
    expect(quickSkip('{"type":"queue-operation","operation":"enqueue"}')).toBe(false)
    expect(classify({ type: 'queue-operation', operation: 'enqueue' })).toBe('noise')
    expect(quickSkip('{"type":"user","message":{"role":"user","content":"{\\"type\\":\\"mode\\"}"}}')).toBe(false)
    // only the line's own type counts, not a type further in
    expect(quickSkip('{"parentUuid":null,"type":"user","message":{"content":"mode"}}')).toBe(false)
  })
})

describe('the shape checks', () => {
  it('every line of tools.jsonl passes', () => {
    for (const l of lines('tools.jsonl')) if (!quickSkip(l)) expect(checkLine(JSON.parse(l)), l.slice(0, 80)).toBeNull()
    for (const name of ['basic.jsonl', 'interrupt.jsonl', 'agent.jsonl', 'ask-plan.jsonl', 'image.jsonl', 'commands.jsonl', 'agent/subagents/agent-afixture01.jsonl']) {
      for (const l of lines(name)) if (!quickSkip(l)) expect(checkLine(JSON.parse(l)), `${name}: ${l.slice(0, 80)}`).toBeNull()
    }
  })

  it('bad.jsonl: one line that is not JSON, two hard problems, two soft ones', () => {
    let parseFailures = 0
    const problems: { hard: boolean; problem: string }[] = []
    for (const l of lines('bad.jsonl')) {
      if (quickSkip(l)) continue
      let obj
      try { obj = JSON.parse(l) } catch { parseFailures++; continue }
      const p = checkLine(obj)
      if (p) problems.push(p)
    }
    expect(parseFailures).toBe(1)
    expect(problems.filter(p => p.hard)).toHaveLength(2)
    expect(problems.filter(p => !p.hard)).toHaveLength(2)
    for (const p of problems) expect(typeof p.problem).toBe('string')
  })

  it('names each hard problem', () => {
    const uuid = '00000000-0000-4000-8000-000000000001'
    expect(checkLine({ type: 'user', message: { content: 'x' } })?.hard).toBe(true)                       // no uuid
    expect(checkLine({ type: 'assistant', uuid, message: { content: 5 } })?.hard).toBe(true)                // content not string/array
    expect(checkLine({ type: 'assistant', uuid, message: { content: [{ type: 'tool_use', id: 'a' }] } })?.hard).toBe(true)
    expect(checkLine({ type: 'user', uuid, message: { content: [{ type: 'tool_result' }] } })?.hard).toBe(true)
    expect(checkLine({ type: 'assistant', uuid, message: { content: [{ type: 'text', text: 3 }] } })?.hard).toBe(true)
    expect(checkLine({ type: 'system', uuid })).toEqual({ hard: false, problem: expect.any(String) })      // no subtype
    expect(checkLine({ type: 'system', subtype: 'turn_duration', uuid })).toBeNull()
    expect(checkLine({ type: 'assistant', uuid, message: { content: [{ type: 'redacted_thinking', data: 'x' }, { type: 'document' }] } })).toBeNull()
  })
})

describe('the Claude Code versions the lens was checked with', () => {
  it('the verified range', () => {
    expect(SUPPORTED).toEqual({ min: '2.1.323', below: '2.2.0' })
  })

  it('reads a version out of what claude --version prints', () => {
    expect(versionVerdict('2.1.323 (Claude Code)')).toBe('ok')
    expect(versionVerdict('2.1.400')).toBe('ok')
    expect(versionVerdict('2.2.0')).toBe('new')
    expect(versionVerdict('3.0.1')).toBe('new')
    expect(versionVerdict('2.1.300')).toBe('old')
    expect(versionVerdict('1.9.999')).toBe('old')
    expect(versionVerdict('')).toBe('unknown')
    expect(versionVerdict(null)).toBe('unknown')
    expect(versionVerdict(undefined)).toBe('unknown')
    expect(versionVerdict('claude')).toBe('unknown')
  })
})
