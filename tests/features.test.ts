// The other-AI-tools switch (Codex CLI and friends, hidden by default): one value in
// electron/features.json, read by the main process and the page alike.

import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { CHAT_VIEW, OTHER_TOOLS, chatViewOn, settingsSections, sessionTools, shownCodexLimits } from '../src/features'

const require = createRequire(import.meta.url)

const SECTIONS: ['notify' | 'session' | 'tools' | 'app', string][] = [['notify', '알림'], ['session', '세션'], ['tools', 'AI 도구'], ['app', '앱']]
const STORED = { tools: [{ id: 'codex', name: 'Codex CLI', command: 'codex' }], defaultTool: 'codex' }
const CODEX = { primary: { usedPercent: 40, windowMinutes: 300, resetsAt: 1 }, secondary: null }

describe('the switch', () => {
  it('the page and the main process read the same value', () => {
    expect(OTHER_TOOLS).toBe(require('../electron/features.cjs').OTHER_TOOLS)
    expect(typeof OTHER_TOOLS).toBe('boolean')
  })
})

describe('other AI tools switched off', () => {
  it('설정 has no AI 도구 section', () => {
    expect(settingsSections(SECTIONS, false).map(([k]) => k)).toEqual(['notify', 'session', 'app'])
  })

  it('a new session can only be Claude Code, even with Codex stored as the default', () => {
    expect(sessionTools(STORED, false)).toEqual({ tools: [], defaultTool: 'claude' })
  })

  it('the stored settings are not changed, only not used', () => {
    sessionTools(STORED, false)
    expect(STORED).toEqual({ tools: [{ id: 'codex', name: 'Codex CLI', command: 'codex' }], defaultTool: 'codex' })
  })

  it("the usage card gets no Codex limits (Claude's rows only)", () => {
    expect(shownCodexLimits(CODEX, false)).toBeUndefined()
  })
})

describe('other AI tools switched on (as before)', () => {
  it('설정 shows every section', () => {
    expect(settingsSections(SECTIONS, true)).toEqual(SECTIONS)
  })

  it('the stored tools and default reach the picker', () => {
    expect(sessionTools(STORED, true)).toEqual(STORED)
  })

  it('Codex limits reach the usage card', () => {
    expect(shownCodexLimits(CODEX, true)).toBe(CODEX)
  })
})

describe('the default follows the switch', () => {
  it('each decision uses OTHER_TOOLS when not told otherwise', () => {
    expect(settingsSections(SECTIONS).some(([k]) => k === 'tools')).toBe(OTHER_TOOLS)
    expect(sessionTools(STORED).defaultTool).toBe(OTHER_TOOLS ? 'codex' : 'claude')
    expect(shownCodexLimits(CODEX)).toBe(OTHER_TOOLS ? CODEX : undefined)
  })
})

// The chat view: its own switch in the same file, on for the
// test build, and a 설정 switch that stays off by default. Both must be on for any of it.
describe('the chat view switch', () => {
  it('is on in features.json for the test build (the 설정 switch stays off by default)', () => {
    expect(require('../electron/features.json').chatView).toBe(true)
  })

  it('the chat view is on only when the switch and the setting are both on', () => {
    expect(chatViewOn({ session: { chatView: true } }, false)).toBe(false)
    expect(chatViewOn({ session: { chatView: true } }, true)).toBe(true)
    expect(chatViewOn({ session: { chatView: false } }, true)).toBe(false)
  })

  it('the page and the main process agree when no development override is set', () => {
    if (process.env.SPAWN_CHAT_VIEW || process.env.VITE_SPAWN_CHAT_VIEW) return
    expect(CHAT_VIEW).toBe(require('../electron/features.cjs').CHAT_VIEW)
    expect(CHAT_VIEW).toBe(true)
  })
})

// In the app, the page follows main's switch (a build made with VITE_SPAWN_CHAT_VIEW set
// cannot show a 설정 row main does not serve), and nothing calls chat:* while it is off
describe('the page follows main\'s chat view switch', () => {
  it('main\'s answer wins over the build\'s; without one (a plain browser, the harness) the build\'s', async () => {
    const { chatViewFlag } = await import('../src/features')
    expect(chatViewFlag(false, true)).toBe(false)
    expect(chatViewFlag(true, false)).toBe(true)
    expect(chatViewFlag(undefined, true)).toBe(true)
    expect(chatViewFlag(undefined, false)).toBe(false)
    expect(chatViewFlag('yes', false)).toBe(false)
  })

  it('main answers the preload synchronously, always (off too); the preload passes it on', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    const main = readFileSync(join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
    expect(main).toMatch(/ipcMain\.on\('features:chat-view', \(event\) => \{ event\.returnValue = CHAT_VIEW === true \}\)/)
    const preload = readFileSync(join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8')
    expect(preload).toContain("ipcRenderer.sendSync('features:chat-view') === true")
    const store = readFileSync(join(__dirname, '..', 'src', 'chat', 'store.ts'), 'utf8')
    expect(store).toContain('createChatStore(CHAT_VIEW ? bridge?.chat ?? null : null)')
  })
})
