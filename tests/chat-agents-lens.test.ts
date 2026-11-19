/**
 * electron/chatLens.cjs — the sub-agents at work (status.agents, the chat's strip): added by SubagentStart (or a
 * sub-agent's first tool call), moved on by its tool calls, paired with its Agent call by its .meta.json, and gone
 * with SubagentStop, its foreground call's end, the turn's end (foreground only), a background one's wake-up, or the
 * session's end. A background one outlives the turn. Fake timers.
 */

import fs, { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIX, hooksOf, linesOf } from './chat-helpers'

const require = createRequire(import.meta.url)
const { createLens } = require('../electron/chatLens.cjs')
const { callKey } = require('../hooks/spawn-hook.cjs')

const PROJECT = 'C--Users-user-work-demo'
const CWD = 'C:\\Users\\user\\work\\demo'
const SID = '00000000-0000-4000-8000-000000000904'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-chat-agents-')); dirs.push(d); return d }

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.setSystemTime(new Date('2026-11-14T12:00:00Z')) })
afterEach(() => { vi.useRealTimers() })

const hooks = hooksOf('hooks-agent.jsonl')
const PRE_AGENT = hooks[0].body
const START = hooks[1].body
const SUB_TOOL = hooks[2].body

/** agent.jsonl through its Agent call (running), its sub-agent's folder beside it with `meta` as its .meta.json */
async function session(meta: Record<string, unknown> | null = { agentType: 'general-purpose', description: 'Count lines in notes.txt', toolUseId: 'toolu_fixture41', requestShape: 'background' }) {
  const claudeDir = tempDir()
  const userDataDir = tempDir()
  const folder = join(claudeDir, 'projects', PROJECT)
  mkdirSync(folder, { recursive: true })
  mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
  const out: string[] = []
  for (const l of linesOf('agent.jsonl')) { out.push(l.text); if (l.text.includes('"name":"Agent"')) break }
  writeFileSync(join(folder, `${SID}.jsonl`), out.join('\n') + '\n')
  cpSync(join(FIX, 'agent'), join(folder, SID), { recursive: true })
  const metaFile = join(folder, SID, 'subagents', 'agent-afixture01.meta.json')
  if (meta) writeFileSync(metaFile, JSON.stringify(meta)); else rmSync(metaFile)
  const updates: any[] = []
  const lens = createLens({ claudeDir, userDataDir, fs, emit: (u: any) => updates.push(u), callKey, watch: () => null })
  const run = async (ms: number) => { for (let t = 0; t < ms; t += 10) { vi.advanceTimersByTime(Math.min(10, ms - t)); await lens.idle() } await lens.idle() }
  const settle = () => run(10)
  const status = () => updates.flatMap(u => u.ops).filter((o: any) => o.op === 'status' || o.op === 'reset').at(-1)?.status
  const upserted = () => updates.flatMap(u => u.ops).filter((o: any) => o.op === 'upsert').flatMap((o: any) => o.items)
  const item = (id: string) => upserted().filter((i: any) => i.id === id).at(-1)
  lens.setTerminals([{ id: SID, cwd: CWD, armed: true, status: 'running' }])
  lens.open(SID)
  await run(20)
  const hook = async (event: string, body: any) => { lens.hook(event, body, Date.now()); await settle() }
  return { lens, run, settle, status, item, hook, folder }
}

describe('status.agents: the sub-agents at work', () => {
  it('SubagentStart adds one; its meta pairs it with its Agent call (two running: never guessed), says what it was asked and that it runs in the background', async () => {
    const s = await session()
    await s.hook('PreToolUse', PRE_AGENT)
    await s.hook('PreToolUse', { ...PRE_AGENT, tool_use_id: 'toolu_fixture43' })
    const at = Date.now()
    await s.hook('SubagentStart', START)
    expect(s.status().agents).toEqual([{ id: 'afixture01', since: at, tools: 0, toolId: 'toolu_fixture41', type: 'general-purpose', description: 'Count lines in notes.txt', background: true }])
    // its row is paired now (the panel can ask for its rows)
    expect(s.item('toolu_fixture41').agentId).toBe('afixture01')
    expect(s.item('toolu_fixture43').agentId).toBeUndefined()
  })

  it('its tool calls move it on: the count and the latest tool (a whitelisted excerpt)', async () => {
    const s = await session()
    await s.hook('PreToolUse', PRE_AGENT)
    await s.hook('SubagentStart', START)
    await s.hook('PreToolUse', SUB_TOOL)
    const [a] = s.status().agents
    expect(a.tools).toBe(1)
    expect(a.last).toEqual({ tool: 'PowerShell', input: { command: SUB_TOOL.tool_input.command } })
  })

  it('a background one outlives the turn and the call\'s answer; its wake-up ends it', async () => {
    const s = await session()
    await s.hook('PreToolUse', PRE_AGENT)
    await s.hook('SubagentStart', START)
    await s.hook('PostToolUse', { ...PRE_AGENT, hook_event_name: 'PostToolUse', tool_response: { isAsync: true, status: 'async_launched', agentId: 'afixture01' } })
    await s.hook('Stop', { session_id: SID, last_assistant_message: '' })
    expect(s.status().agents?.map((a: any) => a.id)).toEqual(['afixture01'])
    await s.hook('UserPromptSubmit', { session_id: SID, prompt: '<task-notification>\n<task-id>afixture01</task-id>\n<status>completed</status>\n</task-notification>' })
    expect(s.status().agents).toBeUndefined()
  })

  it('no meta: the call\'s "launched" answer says it runs in the background, so the turn\'s end keeps it', async () => {
    const s = await session(null)
    await s.hook('PreToolUse', PRE_AGENT)
    await s.hook('SubagentStart', START)
    expect(s.status().agents[0].background).toBeUndefined()
    await s.hook('PostToolUse', { ...PRE_AGENT, hook_event_name: 'PostToolUse', tool_response: { isAsync: true, status: 'async_launched', agentId: 'afixture01' } })
    await s.hook('Stop', { session_id: SID, last_assistant_message: '' })
    expect(s.status().agents).toEqual([expect.objectContaining({ id: 'afixture01', background: true })])
  })

  it('SubagentStop ends it', async () => {
    const s = await session()
    await s.hook('SubagentStart', START)
    expect(s.status().agents).toHaveLength(1)
    await s.hook('SubagentStop', { ...START, hook_event_name: 'SubagentStop' })
    expect(s.status().agents).toBeUndefined()
  })

  it('a foreground one ends with its call, and with the turn', async () => {
    const s = await session({ agentType: 'general-purpose', description: 'fg', toolUseId: 'toolu_fixture41', requestShape: 'foreground' })
    await s.hook('PreToolUse', PRE_AGENT)
    await s.hook('SubagentStart', START)
    expect(s.status().agents?.[0]).toMatchObject({ background: false, description: 'fg' })
    await s.hook('PostToolUse', { ...PRE_AGENT, hook_event_name: 'PostToolUse', tool_response: { status: 'completed', agentId: 'afixture01' } })
    expect(s.status().agents).toBeUndefined()
    // another one, still running when the turn ends
    await s.hook('SubagentStart', START)
    expect(s.status().agents).toHaveLength(1)
    await s.hook('Stop', { session_id: SID, last_assistant_message: '' })
    expect(s.status().agents).toBeUndefined()
  })

  it('no meta: shown from the hooks alone (paired as before only when one Agent row runs); a missed start is caught by its first tool call', async () => {
    const s = await session(null)
    await s.hook('PreToolUse', SUB_TOOL)
    expect(s.status().agents).toEqual([expect.objectContaining({ id: 'afixture01', tools: 1, type: 'general-purpose' })])
    expect(s.status().agents[0].toolId).toBeUndefined()
  })

  it('a sidechain nobody sent (agent_type "": the compaction summariser) is never shown', async () => {
    const s = await session()
    await s.hook('SubagentStart', { ...START, agent_type: '' })
    await s.hook('PreToolUse', { ...SUB_TOOL, agent_type: '' })
    expect(s.status().agents).toBeUndefined()
  })

  it('the session ending lets them all go; an hour without a call lets one go', async () => {
    const s = await session()
    await s.hook('SubagentStart', START)
    vi.setSystemTime(Date.now() + 61 * 60_000)
    await s.hook('PreCompact', { session_id: SID })
    expect(s.status().agents).toBeUndefined()
    await s.hook('SubagentStart', START)
    expect(s.status().agents).toHaveLength(1)
    s.lens.setTerminals([{ id: SID, cwd: CWD, armed: true, status: 'exited' }])
    await s.run(10)
    expect(s.status().agents).toBeUndefined()
  })
})
