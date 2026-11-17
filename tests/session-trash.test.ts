import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { trashSession, restoreSession, purgeTrash } = require('../electron/sessionTrash.cjs')

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const ID = '11111111-2222-4333-8444-555555555555'
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'spawn-trash-'))
  dirs.push(root)
  const claudeDir = join(root, 'claude')
  const spawnHome = join(root, 'spawn')
  const proj = join(claudeDir, 'projects', 'C--work-demo')
  mkdirSync(join(proj, ID, 'subagents'), { recursive: true })
  writeFileSync(join(proj, `${ID}.jsonl`), '{"type":"user"}\n')
  writeFileSync(join(proj, ID, 'subagents', 'agent-a.jsonl'), '{}\n')
  return { claudeDir, spawnHome, proj }
}
const NOW = Date.UTC(2026, 10, 17, 9)

describe('deleting a session: into the trash, back out, gone after 7 days', () => {
  it('moves the transcript and its sub-agents into the day\'s trash', () => {
    const s = setup()
    expect(trashSession({ ...s, id: ID, now: NOW })).toEqual({ ok: true, moved: 1 })
    expect(existsSync(join(s.proj, `${ID}.jsonl`))).toBe(false)
    const day = join(s.spawnHome, 'trash', '2026-11-17', 'C--work-demo')
    expect(existsSync(join(day, `${ID}.jsonl`))).toBe(true)
    expect(existsSync(join(day, ID, 'subagents', 'agent-a.jsonl'))).toBe(true)
  })
  it('a running session, a name that is not a session id, an unknown one: nothing moves', () => {
    const s = setup()
    expect(trashSession({ ...s, id: ID, running: () => true })).toEqual({ ok: false, reason: 'running' })
    expect(trashSession({ ...s, id: '../../etc' })).toEqual({ ok: false, reason: 'invalid' })
    expect(trashSession({ ...s, id: '99999999-2222-4333-8444-555555555555' })).toEqual({ ok: false, reason: 'none' })
    expect(existsSync(join(s.proj, `${ID}.jsonl`))).toBe(true)
  })
  it('restores it where it was', () => {
    const s = setup()
    trashSession({ ...s, id: ID, now: NOW })
    expect(restoreSession({ ...s, id: ID })).toEqual({ ok: true })
    expect(existsSync(join(s.proj, `${ID}.jsonl`))).toBe(true)
    expect(existsSync(join(s.proj, ID, 'subagents', 'agent-a.jsonl'))).toBe(true)
  })
  it('purges day folders older than 7 days, keeps the rest', () => {
    const s = setup()
    trashSession({ ...s, id: ID, now: NOW - 8 * 86_400_000 })
    mkdirSync(join(s.spawnHome, 'trash', '2026-11-15'), { recursive: true })
    expect(purgeTrash({ spawnHome: s.spawnHome, now: NOW })).toBe(1)
    expect(existsSync(join(s.spawnHome, 'trash', '2026-11-09'))).toBe(false)
    expect(existsSync(join(s.spawnHome, 'trash', '2026-11-15'))).toBe(true)
  })
})
