/**
 * What a real-session trial showed (Claude Code 2.1.325).
 *
 * The folder-trust question of a new folder ("Quick safety check … ❯ No, exit / Yes, I trust this folder"), answered in
 * the terminal with ↓ and Enter, left the composer's ledger of the prompt row `unknown`: the page's xterm answers a
 * query of Claude Code's (a terminal report, written back through terminals.write) after the question is drawn, and a
 * write with an ESC clears the side panel's `asking` (release 1.4.0, kept). The ↓ that followed was then heard as a key
 * on the prompt row (↑/↓ recall history: `unknown`), and the first chat send was refused ("터미널 입력란 상태를 알 수
 * 없어요") until a prompt was sent from the terminal or the side box: the row only held Claude Code's dim
 * `Try "…"` placeholder, which a reading of the screen cannot tell from typed text. Seen twice (two new folders).
 *
 * The bytes below are the real draw's shape (cursor moves between the words, each row placed with CUP), the path
 * redacted.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createTerminalManager } = require('../electron/terminals.cjs')
const { chatHookEntries } = require('../electron/chatHooks.cjs')
const { nextDraft } = require('../electron/chatInput.cjs')

const REPO = fileURLToPath(new URL('..', import.meta.url))
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-chat-real5-')); dirs.push(d); return d }
const CHAT = chatHookEntries({ port: 51234, token: 'ab'.repeat(24), id: '00000000-0000-4000-8000-000000000001' })

const w = (s: string) => s.replace(/ /g, '\x1b[1C')
/** Claude Code 2.1.325's trust question as it first draws it (the cursor on "No, exit") */
const TRUST_DRAW = '\x1b[?2026h\x1b[2J\x1b[H' +
  `\x1b[2;2H\x1b[1m${w('Accessing workspace:')}\x1b[22m` +
  `\x1b[4;2H\x1b[1mC:\\Users\\user\\work\\demo\x1b[22m` +
  `\x1b[8;2H${w('Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open')}` +
  `\x1b[11;2H${w("Claude Code'll be able to read, edit, and execute files here.")}` +
  `\x1b[13;2H${w('Security guide')}` +
  `\x1b[38;2;177;185;249m\x1b[15;2H❯\x1b[1C${w('No, exit')}\x1b[m\x1b[16;4H${w('Yes, I trust this folder')}` +
  `\x1b[38;2;153;153;153m\x1b[18;2H${w('Enter to confirm · Esc to cancel')}\x1b[?2026l`
/** ...and after ↓ (only the two choice rows again) */
const TRUST_DOWN = '\x1b[?2026h\x1b[m\x1b[15;2H \x1b[1CNo, exit\x1b[38;2;177;185;249m\x1b[16;2H❯\x1b[1CYes, I trust this folder\x1b[m\x1b[?2026l'
/** What the page's xterm writes back by itself: a focus report, and the answer to an XTVERSION query (`CSI > 0 q`) */
const REPORTS = ['\x1b[I', '\x1bP>|xterm.js(6.0.0)\x1b\\']

function armedTerminal() {
  const writes: string[] = []
  const procs = new Map<number, { onData?: (d: string) => void }>()
  let next = 100
  const pty = {
    spawn() {
      const pid = next++
      const p: { onData?: (d: string) => void } = {}
      procs.set(pid, p)
      return { pid, onData(cb: (d: string) => void) { p.onData = cb }, onExit() {}, kill() {}, write(d: string) { writes.push(d) }, resize() {} }
    },
  }
  const heard: unknown[][] = []
  const userDataDir = tempDir()
  const terms = createTerminalManager({ repoRoot: REPO, userDataDir, defaultCwd: userDataDir, send: () => {}, pty, killTree: () => {}, chat: { state: () => ({ on: true, hooks: CHAT }), onInput: (...a: unknown[]) => heard.push(a) } })
  const t = terms.create({})
  const out = (d: string) => procs.get(100)?.onData?.(d)
  return { terms, t, out, heard, writes }
}

describe('real trial: the folder-trust question answered in the terminal leaves the prompt row known', () => {
  for (const report of REPORTS) {
    it(`a terminal report (${JSON.stringify(report)}) between the question and the keys: ↓ and Enter still answer the question`, () => {
      const { terms, t, out, heard, writes } = armedTerminal()
      out(TRUST_DRAW)
      expect(terms.list().find((x: any) => x.id === t.id).asking).toBe(true)
      terms.write(t.id, report)
      // the side panel's flag as in release 1.4.0: cleared by any write with an ESC
      expect(terms.list().find((x: any) => x.id === t.id).asking).toBe(false)
      terms.write(t.id, '\x1b[B')
      out(TRUST_DOWN)
      terms.write(t.id, '\r')
      // the bytes reach the pty unchanged
      expect(writes).toEqual([report, '\x1b[B', '\r'])
      const asked = heard.map((a) => [a[1], a[4]])
      expect(asked).toEqual([[report, true], ['\x1b[B', true], ['\r', true]])
      // the ledger as the host keeps it: clean all through, so the first chat send is not refused
      let d = 'clean'
      for (const a of heard) d = nextDraft(d, { via: 'keyboard', data: a[1], dialog: a[4] === true })
      expect(d).toBe('clean')
      // the question answered: keys on the prompt row are heard as such again
      out('\x1b[?1049h\x1b[2J\x1b[H❯ \x1b[2mTry "refactor <filepath>"\x1b[22m')
      terms.write(t.id, 'hi')
      expect(heard.at(-1)).toEqual([t.id, 'hi', 'keyboard', undefined, false])
    })
  }

  it('a question answered by a digit (no Enter) is over with that key; arrows alone keep it', () => {
    const { terms, t, out, heard } = armedTerminal()
    out(TRUST_DRAW)
    terms.write(t.id, '\x1b[I')
    terms.write(t.id, '\x1b[A')
    terms.write(t.id, '\x1b[B')
    terms.write(t.id, '2')
    terms.write(t.id, 'x')
    expect(heard.map((a) => [a[1], a[4]])).toEqual([['\x1b[I', true], ['\x1b[A', true], ['\x1b[B', true], ['2', true], ['x', false]])
  })

  it('a question cleared from the chat (a held request answered) is over for the ledger too', () => {
    const { terms, t, out, heard } = armedTerminal()
    out(TRUST_DRAW)
    terms.write(t.id, '\x1b[I')
    terms.clearAsking(t.id)
    terms.write(t.id, 'x')
    expect(heard.at(-1)).toEqual([t.id, 'x', 'keyboard', undefined, false])
  })

  it('no question drawn: a report and ↓ are heard as before (↓ on the prompt row recalls history: unknown)', () => {
    const { terms, t, out, heard } = armedTerminal()
    out('❯ \x1b[7m \x1b[27m')
    terms.write(t.id, '\x1b[I')
    terms.write(t.id, '\x1b[B')
    expect(heard.map((a) => [a[1], a[4]])).toEqual([['\x1b[I', false], ['\x1b[B', false]])
    let d = 'clean'
    for (const a of heard) d = nextDraft(d, { via: 'keyboard', data: a[1], dialog: a[4] === true })
    expect(d).toBe('unknown')
  })
})
