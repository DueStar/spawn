/**
 * 1.5.3: a send the page refuses for its screen is logged with the screen's shape (spawn.log), never its text,
 * so a prompt box drawn in a shape the page does not know yet can be seen without a screenshot.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { screenShape } from '../src/chat/promptRow'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('screenShape', () => {
  it('masks every letter and digit (Korean too), keeps the rules, marks and indentation, folds long runs', () => {
    const screen = ['● 비밀 secret 42', '', '─'.repeat(40) + ' Spawn ─', '❯ 안녕 hello', '─'.repeat(40), '  Opus 5.5 · ctx 28%'].join('\n')
    const shape = screenShape(screen)
    expect(shape).not.toMatch(/비밀|secret|42|Spawn|안녕|hello|Opus/)
    expect(shape).toContain('─×40·aaaaa·─')
    expect(shape).toContain('❯·aa·aaaaa')
    expect(shape).toContain('··aaaa·a.a·')
    expect(shape.split('\n').every(l => l.length <= 160)).toBe(true)
  })

  it('shows a no-break space as ⍽ and an unknown symbol by its code point', () => {
    const shape = screenShape(['─'.repeat(30), '❯ x', '━'.repeat(3), '  ★'].join('\n'))
    expect(shape).toContain('❯⍽a')
    expect(shape).toContain('{2501}{2501}{2501}')
    expect(shape).toContain('··{2605}')
  })

  it('says so when there is no terminal text', () => {
    expect(screenShape(null)).toBe('(no terminal text)')
  })
})

describe('the wiring', () => {
  it('the page sends its refusal for the screen to main with the shape; main masks again and logs once per 30 s', () => {
    const send = read('src/chat/send.ts')
    expect(send).toMatch(/d\.bridge\.diag\?\.\(\{ id, why: row\.why, shape: screenShape\(d\.readScreen\(id\)\) \}\)/)
    expect(read('electron/preload.cjs')).toMatch(/diag: \(p\) => ipcRenderer\.send\('chat:diag'/)
    const host = read('electron/chatHost.cjs')
    expect(host).toMatch(/ipcMain\.on\('chat:diag'/)
    expect(host).toMatch(/replace\(\/\[\\p\{L\}\\p\{N\}\]\/gu, 'a'\)/)
    expect(host).toMatch(/< 30_000\) return/)
    expect(host).toMatch(/refused\('send', await send\(/)
  })
})
