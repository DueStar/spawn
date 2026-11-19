/**
 * /exit closes the tab as the left panel's × does (2026-11-19): a clean exit with Claude Code's goodbye in its last
 * output; a crash, a kill or a shutdown (no goodbye, or a non-zero code) keeps the tab.
 */

import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createTerminalManager, GOODBYE } = require('../electron/terminals.cjs')
const REPO = join(__dirname, '..')

function fakePty() {
  let next = 100
  const procs = new Map<number, { onExit?: (e: { exitCode: number }) => void; onData?: (d: string) => void }>()
  return {
    procs,
    end(pid: number, code: number) { procs.get(pid)?.onExit?.({ exitCode: code }) },
    data(pid: number, d: string) { procs.get(pid)?.onData?.(d) },
    spawn() {
      const pid = next++
      const p = {} as { onExit?: (e: { exitCode: number }) => void; onData?: (d: string) => void }
      procs.set(pid, p)
      return { pid, onData(cb: (d: string) => void) { p.onData = cb }, onExit(cb: (e: { exitCode: number }) => void) { p.onExit = cb }, kill() {}, write() {}, resize() {} }
    },
  }
}

function setup() {
  const pty = fakePty()
  const dir = mkdtempSync(join(tmpdir(), 'spawn-exit-'))
  const terms = createTerminalManager({ repoRoot: REPO, userDataDir: dir, defaultCwd: dir, send: () => {}, pty, killTree: () => {}, exitGraceMs: 10 })
  const t = terms.create({ cwd: dir })
  return { pty, terms, t, pid: 100 }
}

describe('/exit closes the tab', () => {
  it('knows the goodbyes Claude Code prints', () => {
    for (const g of ['Goodbye!', 'See ya!', 'Bye!', 'Catch you later!']) expect(GOODBYE.test(`\r\n ${g}\r\n`)).toBe(true)
    expect(GOODBYE.test('Error: something broke')).toBe(false)
  })

  it('a clean exit with a goodbye: the tab goes, as the panel\'s × makes it go', async () => {
    vi.useFakeTimers()
    try {
      const { pty, terms, t, pid } = setup()
      pty.data(pid, '\x1b[2m> /exit\x1b[0m\r\n  Bye!\r\n')
      vi.advanceTimersByTime(100)
      pty.end(pid, 0)
      expect(terms.list().some((x: { id: string }) => x.id === t.id)).toBe(true)
      vi.advanceTimersByTime(2000)
      expect(terms.list().some((x: { id: string }) => x.id === t.id)).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('a crash or a kill (no goodbye, or a non-zero code) keeps the tab', () => {
    vi.useFakeTimers()
    try {
      const a = setup()
      a.pty.data(a.pid, 'working…\r\n')
      vi.advanceTimersByTime(100)
      a.pty.end(a.pid, 0)
      vi.advanceTimersByTime(3000)
      expect(a.terms.list().some((x: { id: string }) => x.id === a.t.id)).toBe(true)
      const b = setup()
      b.pty.data(b.pid, 'Bye!\r\n')
      vi.advanceTimersByTime(100)
      b.pty.end(b.pid, 1)
      vi.advanceTimersByTime(3000)
      expect(b.terms.list().some((x: { id: string }) => x.id === b.t.id)).toBe(true)
    } finally { vi.useRealTimers() }
  })
})
