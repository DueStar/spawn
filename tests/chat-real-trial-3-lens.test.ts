/**
 * What the Phase 3 trial showed in the lens (Claude Code 2.1.325): a permission refused with Esc
 * in the terminal of a session whose chat was not shown. No hook follows that refusal (no
 * PostToolUse, no Stop), and the transcript lines that close the turn (the rejected result, the
 * "[Request interrupted…]" notice, the turn's duration) were read only later, as history, when the
 * view opened: the status stayed "waiting" for good, and the composer refused every send.
 */

import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createLens } = require('../electron/chatLens.cjs')
const { callKey } = require('../hooks/spawn-hook.cjs')

const PROJECT = 'C--Users-user-work-demo'
const CWD = 'C:\\Users\\user\\work\\demo'
const SID = '00000000-0000-4000-8000-000000000601'
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-chat-trial3-')); dirs.push(d); return d }
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.setSystemTime(new Date('2026-11-15T08:08:42Z')) })
afterEach(() => { vi.useRealTimers() })

const LINES = readFileSync(join(__dirname, 'fixtures', 'chat', 'rejected-unseen.jsonl'), 'utf8').split('\n').filter(Boolean)
const body = (event: string, extra: Record<string, unknown> = {}) => ({ session_id: SID, transcript_path: 'C:\\Users\\user\\.claude\\projects\\x.jsonl', cwd: CWD, hook_event_name: event, ...extra })

describe('a permission refused in the terminal while the chat was not shown', () => {
  it('the view opened later reads the turn as over: idle, not waiting', async () => {
    const claudeDir = tempDir()
    const userDataDir = tempDir()
    mkdirSync(join(claudeDir, 'projects', PROJECT), { recursive: true })
    mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
    const file = join(claudeDir, 'projects', PROJECT, `${SID}.jsonl`)
    const updates: any[] = []
    const lens = createLens({ claudeDir, userDataDir, fs, emit: (u: any) => updates.push(u), callKey, watch: () => null })
    const run = async (ms: number) => { for (let t = 0; t < ms; t += 10) { vi.advanceTimersByTime(Math.min(10, ms - t)); await lens.idle() } await lens.idle() }
    const status = () => { let st: any = null; for (const u of updates) for (const op of u.ops) if (op.op === 'reset' || op.op === 'status') st = op.status; return st }
    lens.setTerminals([{ id: SID, cwd: CWD, armed: true, status: 'running' }])
    writeFileSync(file, LINES[0] + '\n')
    lens.hook('UserPromptSubmit', body('UserPromptSubmit', { prompt: 'Create a file named c.txt containing the single letter c.' }), Date.now())
    await run(6000)
    lens.hook('PreToolUse', body('PreToolUse', { tool_name: 'Write', tool_use_id: 'toolu_fixture0601', tool_input: { file_path: 'C:\\Users\\user\\work\\demo\\c.txt', content: 'c' } }), Date.now())
    lens.hook('PermissionRequest', body('PermissionRequest', { tool_name: 'Write', tool_input: { file_path: 'C:\\Users\\user\\work\\demo\\c.txt', content: 'c' } }), Date.now())
    await run(29000)
    // Esc in the terminal: no hook; the record closes the turn
    writeFileSync(file, LINES.join('\n') + '\n')
    await run(1000)
    lens.open(SID)
    await run(500)
    expect(status()?.state).toBe('idle')
  })

  it('a turn still running when the view opens stays working', async () => {
    const claudeDir = tempDir()
    const userDataDir = tempDir()
    mkdirSync(join(claudeDir, 'projects', PROJECT), { recursive: true })
    mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
    const file = join(claudeDir, 'projects', PROJECT, `${SID}.jsonl`)
    const updates: any[] = []
    const lens = createLens({ claudeDir, userDataDir, fs, emit: (u: any) => updates.push(u), callKey, watch: () => null })
    const run = async (ms: number) => { for (let t = 0; t < ms; t += 10) { vi.advanceTimersByTime(Math.min(10, ms - t)); await lens.idle() } await lens.idle() }
    const status = () => { let st: any = null; for (const u of updates) for (const op of u.ops) if (op.op === 'reset' || op.op === 'status') st = op.status; return st }
    lens.setTerminals([{ id: SID, cwd: CWD, armed: true, status: 'running' }])
    writeFileSync(file, LINES.slice(0, 2).join('\n') + '\n')
    lens.hook('UserPromptSubmit', body('UserPromptSubmit', { prompt: 'Create a file named c.txt containing the single letter c.' }), Date.now())
    lens.hook('PermissionRequest', body('PermissionRequest', { tool_name: 'Write', tool_input: { file_path: 'C:\\Users\\user\\work\\demo\\c.txt', content: 'c' } }), Date.now())
    lens.open(SID)
    await run(500)
    expect(status()?.state).toBe('waiting')
  })
})
