import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { footerMode } from '../src/chat/promptRow'

const screen = (name: string) => readFileSync(join(__dirname, 'fixtures', 'chat', 'screens', `${name}.txt`), 'utf8')

describe('the permission mode in Claude Code\'s footer', () => {
  it('reads the real screens', () => {
    expect(footerMode(screen('real-idle-empty-nbsp'))).toBe('auto')
    expect(footerMode(screen('real-named-session'))).toBe('acceptEdits')
    expect(footerMode(screen('real-agents-panel'))).toBe('acceptEdits')
    // ("⏸ manual mode on": the default mode, as 2.1.32x names it)
    expect(footerMode(screen('idle-empty'))).toBe('default')
  })
  it('plan mode, bypass, and a footer naming none', () => {
    const R = '─'.repeat(40)
    const box = (foot: string) => ['x', R, '❯ ', R, '  Opus 5.5 · ctx 3%', foot].join('\n')
    expect(footerMode(box('  ⏸ plan mode on (shift+tab to cycle)'))).toBe('plan')
    expect(footerMode(box('  ⏵⏵ bypass permissions on (shift+tab to cycle)'))).toBe('bypassPermissions')
    expect(footerMode(box('  ? for shortcuts'))).toBe('default')
  })
  it('a dialog or no box: not read', () => {
    expect(footerMode(screen('dialog-plan'))).toBeNull()
    expect(footerMode(screen('no-box-shell'))).toBeNull()
    expect(footerMode(null)).toBeNull()
  })
})
