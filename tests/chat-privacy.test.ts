/**
 * Privacy: nothing of a conversation reaches a log, storage or a file; previews leave nothing
 * behind.
 *
 * - Logs: no log call of the chat's main-side files (electron/chat*.cjs, electron/link*.cjs) interpolates a text, a
 *   prompt, a URL, a file, a path, a title, a body, a command or content; the lens over every fixture logs nothing
 *   longer than six characters taken from them.
 * - Crash dumps: crashReporter is started nowhere (a later merge that adds one fails here and asks for a decision).
 * - localStorage: the chat's page code keeps the three words-or-numbers keys (here); --flow chat-a11y-walk dumps the
 *   page's storage after its walk (density, panel, find): only the known keys, the chat's a word or a number, the
 *   carry's chatModes ids and words only (tests/visual/shots.mjs).
 * - Temp files: link previews write no file (linkFetch.cjs / linkPreview.cjs require no fs); the image store's folder
 *   is removed with its session (tests/chat-images.test.ts).
 * - The steps' read: GET /pokedex without credentials, cache or referrer, and no session text in it.
 */

import fs, { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { FIX } from './chat-helpers'

const require = createRequire(import.meta.url)
const { createLens } = require('../electron/chatLens.cjs')
const { callKey } = require('../hooks/spawn-hook.cjs')

const ROOT = join(__dirname, '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const MAIN_FILES = readdirSync(join(ROOT, 'electron')).filter(f => /^(chat|link)\w*\.cjs$/.test(f))

describe('logs', () => {
  it('no log call of the chat\'s main-side files interpolates text, a prompt, a URL, a file, a path, a title, a body, a command or content', () => {
    // (an error's class name, err?.name, is a fixed word: not denied)
    const DENY = /\b(text|prompt|url|href|file|path|title|body|command|content|delta|message|question|answer)\b/i
    const CALL = /\blogOnce\(|\blog\(|console\.\w+\(/g
    let calls = 0
    for (const f of MAIN_FILES) {
      const src = code(read('electron', f))
      for (const m of src.matchAll(CALL)) {
        const rest = src.slice(m.index!, src.indexOf('\n', m.index!) + 1)
        calls++
        for (const tpl of rest.matchAll(/`((?:[^`\\]|\\.)*)`/g)) {
          for (const x of tpl[1].matchAll(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g)) expect(DENY.test(x[1]), `${f}: ${rest.trim().slice(0, 140)}`).toBe(false)
        }
      }
    }
    expect(calls).toBeGreaterThan(20)
  })

  it('the lens over every fixture logs nothing taken from the conversations (no run of 7+ characters of their words)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    try {
      const claudeDir = mkdtempSync(join(tmpdir(), 'spawn-chat-privacy-')); dirs.push(claudeDir)
      const userDataDir = mkdtempSync(join(tmpdir(), 'spawn-chat-privacy-ud-')); dirs.push(userDataDir)
      const PROJECT = 'C--Users-user-work-demo'
      mkdirSync(join(claudeDir, 'projects', PROJECT), { recursive: true })
      mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
      const logs: string[] = []
      const lens = createLens({ claudeDir, userDataDir, fs, emit: () => {}, callKey, watch: () => null, log: (_l: string, m: string) => logs.push(m), version: '2.3.0 (Claude Code)' })
      const files = readdirSync(FIX).filter(f => f.endsWith('.jsonl'))
      const words = new Set<string>()
      const terms: any[] = []
      files.forEach((f, i) => {
        const id = `00000000-0000-4000-8000-${String(900000000000 + i)}`
        const text = readFileSync(join(FIX, f), 'utf8')
        writeFileSync(join(claudeDir, 'projects', PROJECT, `${id}.jsonl`), text)
        // the conversation's own words: every string value of every line, cut in runs of 7 characters
        for (const line of text.split('\n')) {
          let obj: unknown
          try { obj = JSON.parse(line) } catch { continue }
          const walk = (v: unknown, key = '') => {
            if (typeof v === 'string') { if (!/^(type|role|uuid|parentUuid|timestamp|sessionId|id|tool_use_id|model|stop_reason|subtype|version|cwd|promptId|gitBranch|userType|entrypoint|requestId|level|operation|name)$/.test(key) && v.length >= 7) for (let k = 0; k + 7 <= v.length; k += 3) words.add(v.slice(k, k + 7)) }
            else if (Array.isArray(v)) v.forEach(x => walk(x, key))
            else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k)
          }
          walk(obj)
        }
        terms.push({ id, cwd: 'C:\\Users\\user\\work\\demo', armed: true, status: 'running' })
      })
      lens.setTerminals(terms)
      for (const t of terms) lens.open(t.id)
      for (let k = 0; k < 400; k++) { vi.advanceTimersByTime(10); await lens.idle() }
      for (const t of terms) lens.hook('Stop', { session_id: t.id, hook_event_name: 'Stop', last_assistant_message: 'a different answer altogether' }, Date.now())
      for (let k = 0; k < 600; k++) { vi.advanceTimersByTime(10); await lens.idle() }
      lens.dispose()
      expect(logs.length).toBeGreaterThan(0)
      // (a run that is also in the chat's own source is one of its fixed words, e.g. "Claude Code": not the conversation's)
      const SRC = MAIN_FILES.map(f => read('electron', f)).join('\n')
      const leaks = logs.filter(m => [...words].some(w => /[A-Za-z\uac00-\ud7a3]{3}/.test(w) && m.includes(w) && !SRC.includes(w)))
      expect(leaks).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  }, 60_000)
})

describe('crash dumps, storage and files', () => {
  it('crashReporter is started nowhere in the app (main, preload, page)', () => {
    const all = [...readdirSync(join(ROOT, 'electron')).filter(f => f.endsWith('.cjs')).map(f => ['electron', f]), ['src', 'main.tsx']]
    for (const p of all) expect(code(read(...p)), p.join('/')).not.toMatch(/crashReporter\s*\.\s*start/)
  })

  it('the chat\'s page code keeps exactly three localStorage keys, each a word or a number', () => {
    const files = [
      ...readdirSync(join(ROOT, 'src', 'chat')).map(f => join('src', 'chat', f)),
      ...readdirSync(join(ROOT, 'src', 'components', 'chat')).map(f => join('src', 'components', 'chat', f)),
      join('src', 'components', 'ChatView.tsx'), join('src', 'changesWidth.ts'),
    ]
    const keys = new Set<string>()
    for (const f of files) for (const m of read(f).matchAll(/'(spawn-[a-z0-9-]+)'/g)) keys.add(m[1])
    expect([...keys].sort()).toEqual(['spawn-changes-open', 'spawn-changes-w', 'spawn-chat-density'])
  })

  it('link previews write no file and read none: linkFetch.cjs and linkPreview.cjs require no fs', () => {
    for (const f of ['linkFetch.cjs', 'linkPreview.cjs']) expect(code(read('electron', f)), f).not.toMatch(/require\(['"](node:)?fs(\/promises)?['"]\)/)
  })

  it('the steps\' read: GET /pokedex without credentials, cache or referrer, nothing of the session in its URL', () => {
    const src = code(read('src', 'chat', 'steps.ts'))
    const calls = [...src.matchAll(/fetch\(([^\n]*)/g)].map(m => m[1])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('/pokedex`')
    expect(calls[0]).toContain("credentials: 'omit'")
    expect(calls[0]).toContain("cache: 'no-store'")
    expect(calls[0]).toContain("referrerPolicy: 'no-referrer'")
    // (the URL: the call's first argument)
    expect(calls[0].match(/^`[^`]*`/)?.[0]).toBe('`${serverHttpBase()}/pokedex`')
  })
})
