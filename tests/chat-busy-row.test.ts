/**
 * Words left on the terminal's prompt row never stop a send from the chat (what is sent is
 * what was typed in the chat): on prompt-busy the composer clears the row (src/chat/clearRow.ts) and sends
 * its message, once, without asking; only a row it could not clear is said.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(__dirname, '..', 'src', 'components', 'chat', 'Composer.tsx'), 'utf8')

describe('the composer and words left on the terminal prompt row', () => {
  it('clears the row and sends on prompt-busy, once (no note to answer)', () => {
    expect(src).toContain("else if (r.reason === 'prompt-busy' && !retried && chat.dialogKey) clearFirst = true")
    // after the first try has let go of the composer (sending.current), the row is cleared and the message sent again
    const fin = src.indexOf('if (clearFirst) await takeRow(\'\', true)')
    expect(fin).toBeGreaterThan(src.indexOf('sending.current = false', src.indexOf('async function send(')))
    expect(src).toContain('await send(true)')
  })

  it('says so only when the row could not be cleared', () => {
    expect(src).toContain("if (!cleared) { say({ key: 'Claude Code 입력란을 비우지 못했어요. 잠시 뒤 다시 해 주세요' }, 5000); return }")
  })

  it('never passes an event as `retried` (send is only called with no argument or true)', () => {
    expect(src).not.toMatch(/=\{send\}/)
    for (const m of src.matchAll(/\bsend\(([^)]*)\)/g)) if (m[1] !== 'retried = false') expect(['', 'true']).toContain(m[1])
  })
})
