/**
 * /remote-control (/rc) in the chat (2026-11-23): Claude Code writes the link as a system line
 * (subtype bridge_status, with url) and a local command's words as <local-command-stdout>; the terminal shows
 * both, the chat showed neither. Now: a notice "원격 제어가 켜졌어요" with the link, and a command's words.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createItemBuilder } = require('../electron/chatItems.cjs')
const at = '2026-11-23T08:29:34.153Z'
const bridge = (url: unknown) => ({ type: 'system', subtype: 'bridge_status', content: `/remote-control is active · Continue here, on your phone, or at ${url}`, url, isMeta: false, timestamp: at, uuid: '00000000-0000-4000-8000-000000000b01' })
const sys = (content: string) => ({ type: 'system', subtype: 'local_command', content, timestamp: at, uuid: '00000000-0000-4000-8000-000000000b02' })
const user = (content: string) => ({ type: 'user', message: { role: 'user', content }, timestamp: at, uuid: '00000000-0000-4000-8000-000000000b03' })

describe('remote control and a command\'s words in the chat', () => {
  it('bridge_status → a remote notice carrying its claude.ai link', () => {
    const b = createItemBuilder({ cwd: '/w' })
    expect(b.line(bridge('https://claude.ai/code/session_01LECh1DkdyN26mUmzJWoNm9'), 1)).toMatchObject([{ kind: 'notice', notice: 'remote', text: 'https://claude.ai/code/session_01LECh1DkdyN26mUmzJWoNm9' }])
  })
  it('a link that is not https claude.ai is not offered (the notice still says it is on)', () => {
    const b = createItemBuilder({ cwd: '/w' })
    for (const u of ['http://claude.ai/code/x', 'https://evil.example/code/x', 'javascript:alert(1)', 42, undefined]) {
      const [it] = b.line(bridge(u), 1)
      expect(it, String(u)).toMatchObject({ kind: 'notice', notice: 'remote' })
      expect(it.text, String(u)).toBeUndefined()
    }
  })
  it('a command\'s words (system or user line) → a command-output notice; empty words → nothing', () => {
    const b = createItemBuilder({ cwd: '/w' })
    expect(b.line(user('<local-command-stdout>Login successful. Remote Control disconnected.</local-command-stdout>'), 1)).toMatchObject([{ kind: 'notice', notice: 'command-output', text: 'Login successful. Remote Control disconnected.' }])
    expect(b.line(sys('<local-command-stdout>Set model to \u001b[1mhaiku\u001b[22m</local-command-stdout>'), 2)).toMatchObject([{ kind: 'notice', notice: 'command-output', text: 'Set model to haiku' }])
    expect(b.line(sys('<local-command-stdout></local-command-stdout>'), 3)).toEqual([])
    expect(b.line(user('<local-command-stdout>  </local-command-stdout>'), 4)).toEqual([])
  })
  it('the page says them: words in ko / en / ja, the link opens through openUrlFromChat', async () => {
    const find = readFileSync(new URL('../src/chat/find.ts', import.meta.url), 'utf8')
    expect(find).toMatch(/remote: '원격 제어가 켜졌어요 · 휴대폰이나 브라우저에서 이어서 할 수 있어요'/)
    expect(find).toMatch(/'command-output': ''/)
    const view = readFileSync(new URL('../src/components/ChatView.tsx', import.meta.url), 'utf8')
    expect(view).toMatch(/kind === 'remote'[\s\S]{0,200}openUrlFromChat\(item\.text!?\)/)
    const DICTS = (await import('../src/locales/index')).default
    for (const lang of ['en', 'ja'] as const) for (const k of ['원격 제어가 켜졌어요 · 휴대폰이나 브라우저에서 이어서 할 수 있어요', '링크 열기']) expect(DICTS[lang][k], `${lang} ${k}`).toBeTruthy()
  })
})
