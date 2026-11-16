/**
 * 1.6.2: a session name changed in the app becomes Claude Code's own (/rename), typed with Enter. On 1.6.1 a rename
 * left pending while Claude worked was typed the moment the turn ended — into the middle of what the owner was
 * writing ("…다른 세션 갔/rename Spawn (New)다"), whose half was then sent. And a shell tab's rename was typed into
 * PowerShell. Now: Claude Code sessions only, only when the page reads an empty prompt row (or only a dim
 * suggestion: src/chat/promptRow.ts renameReady), and main refuses it within 1.5 s of a key (`typing`); refused, it
 * stays pending.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const widget = readFileSync(join(ROOT, 'src', 'Widget.tsx'), 'utf8')
const main = readFileSync(join(ROOT, 'electron', 'main.cjs'), 'utf8')

describe('the pending /rename', () => {
  it('is typed only into an empty row of a Claude Code session, read on the page right before', () => {
    expect(widget).toContain("renameReady(promptRow(termText(id), termDim(id)))")
    expect(widget).toMatch(/const renames = \(r: Row\) => r\.terminal\?\.tool === 'claude'/)
  })

  it('stays pending when main says busy or typing', () => {
    expect(widget).toContain("res.reason === 'busy' || res.reason === 'typing'")
  })

  it('goes through the IPC with notWhileTyping (main\'s own launch instruction does not)', () => {
    expect(main).toContain("terminals.sendInstruction(String(id), text, { notWhileTyping: true })")
    expect(main).toMatch(/setTimeout\(\(\) => terminals\.sendInstruction\(t\.id, instruction\)/)
  })
})
