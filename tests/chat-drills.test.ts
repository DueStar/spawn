/**
 * Failure drills (Phase 6, Task 6.6). Each is simulated here; nothing touches the owner's machine (no sleep, no clock
 * change, no full disk). The endpoint's and the worker's drills are in tests/chat-host.test.ts ("Phase 6 drills").
 *
 * - A full disk for the composer's images: the refusal says so (`io` → 이미지를 저장하지 못했어요), no partial file is left,
 *   the session's counts are not spent, and the next image saves once there is room.
 * - Sleep with a hold open: a two-hour jump releases it as `timeout` exactly once, a late answer is `gone`, and a
 *   client that went meanwhile (its response throws) is dropped without a throw.
 * - The clock moved: the working time never shows a negative time; a step bracket whose end is before its start
 *   gives no count; a wild row needs its event inside the conversation's window.
 */

import fs, { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { formatDuration } from '../src/chat/toolLabel'
import { wildEntries } from '../src/chat/wild'
import chat from '../src/locales/chat'

const require = createRequire(import.meta.url)
const { createImageStore } = require('../electron/chatImages.cjs')
const { createHolds, HOLD } = require('../electron/chatHolds.cjs')

const ROOT = join(__dirname, '..')
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const T = '11111111-1111-4111-8111-111111111111'
const PNG = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'chat', 'preview', 'tiny.png')))

describe('drill: the disk is full when an image is pasted', () => {
  it('io, no partial file left, the session\'s count not spent; the next image saves once there is room', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spawn-chat-drill-img-')); dirs.push(root)
    let full = true
    const logs: string[] = []
    const fsx = {
      ...fs.promises,
      // a write that runs out of room half way: the file is made, part of it written, then ENOSPC
      writeFile: async (file: string, bytes: Uint8Array, opts: any) => {
        if (!full) return fs.promises.writeFile(file, bytes, opts)
        await fs.promises.writeFile(file, bytes.subarray(0, Math.floor(bytes.byteLength / 2)), opts)
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
      },
    }
    const store = createImageStore({ root, fs: fsx, log: (_l: string, m: string) => logs.push(m), caps: { bytes: 10 << 20, perSession: 2, sessionBytes: 256 << 20 } })
    expect(await store.save(T, PNG)).toEqual({ ok: false, reason: 'io' })
    expect(readdirSync(join(root, T))).toEqual([])
    expect(logs).toEqual(['chat images: an image could not be saved (ENOSPC)'])
    // two more failures do not use up the session's two images
    await store.save(T, PNG)
    await store.save(T, PNG)
    full = false
    const ok = await store.save(T, PNG)
    expect(ok).toMatchObject({ ok: true, type: 'png' })
    expect(readdirSync(join(root, T))).toHaveLength(1)
    expect(await store.save(T, PNG)).toMatchObject({ ok: true })
    expect(await store.save(T, PNG)).toEqual({ ok: false, reason: 'limit' })
  })

  it('the composer says it in ko / en / ja', () => {
    const src = readFileSync(join(ROOT, 'src', 'components', 'chat', 'Composer.tsx'), 'utf8')
    expect(src).toMatch(/if \(reason === 'io'\) return \{ key: '이미지를 저장하지 못했어요'(, image: true)? \}/)
    expect(chat.en['이미지를 저장하지 못했어요']).toBe("Couldn't save the image")
    expect(chat.ja['이미지를 저장하지 못했어요']).toBe('画像を保存できませんでした')
  })
})

describe('drill: the PC sleeps with a card open', () => {
  function clock() {
    let now = 0
    let seq = 0
    const q = new Map<number, { at: number; f: () => void }>()
    return {
      timers: { setTimeout(f: () => void, ms: number) { const id = ++seq; q.set(id, { at: now + ms, f }); return id }, clearTimeout(id: unknown) { q.delete(id as number) } },
      // a resume: every timer due by now fires at once, in order
      jump(ms: number) {
        now += ms
        for (;;) { const due = [...q].filter(e => e[1].at <= now).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; q.delete(due[0]); due[1].f() }
      },
    }
  }
  const shown = (id: string) => ({ visibleId: id, windowVisible: true })

  it('two hours in one step: released as timeout exactly once; a late answer is gone', () => {
    const c = clock()
    const changes: any[] = []
    const holds = createHolds({ timers: c.timers, limits: HOLD, onChange: (e: any) => changes.push(e) })
    const got: (string | null)[] = []
    const h = holds.open('permission', (b: string | null) => got.push(b), { id: T })
    holds.bind(h, { id: T, key: 'k', data: { rules: [] } })
    c.jump(2 * 60 * 60 * 1000)
    expect(got).toEqual([null])
    expect(changes.filter(e => e.holdId === h && e.state === 'released')).toEqual([expect.objectContaining({ why: 'timeout' })])
    expect(holds.answer(h, { id: T, choice: 'allow', ...shown(T) })).toEqual({ ok: false, reason: 'gone' })
    c.jump(60_000)
    expect(got).toEqual([null])
  })

  it('the client closed its connection meanwhile (the response throws): no throw, the hold is gone, nothing sent twice', () => {
    const c = clock()
    const changes: any[] = []
    const holds = createHolds({ timers: c.timers, limits: HOLD, onChange: (e: any) => changes.push(e) })
    let calls = 0
    const h = holds.open('question', () => { calls++; throw Object.assign(new Error('socket closed'), { code: 'ERR_STREAM_DESTROYED' }) }, { id: T })
    holds.bind(h, { id: T, key: 'k', data: {} })
    expect(() => c.jump(2 * 60 * 60 * 1000)).not.toThrow()
    expect(calls).toBe(1)
    // (a release that could not be written is still a release: no decision went, and nothing is sent again)
    expect(['released', 'gone']).toContain(changes.at(-1).state)
    expect(changes.filter(e => e.holdId === h && ['released', 'gone', 'answered'].includes(e.state))).toHaveLength(1)
  })
})

describe('drill: the clock moved an hour', () => {
  it('the working time never goes below 0 s', () => {
    expect(formatDuration(-3_600_000)).toEqual({ text: '{n}초', vars: { n: 0 } })
  })

  it('a wild row only for an event inside the conversation\'s window, however the clock moved', () => {
    const ev = (at: number) => ({ kind: 'catch', id: 19, name: '꼬렛', tier: 'common', level: 4, sessionId: 's-1', at, shiny: false, newSpecies: false, ball: 'poke-ball' }) as any
    const from = Date.UTC(2026, 10, 16, 12, 0, 0)
    // the clock went back an hour: "now" is before the conversation's first item → nothing, not a reversed window
    expect(wildEntries([ev(from - 30 * 60_000), ev(from + 10_000)], 's-1', { from, to: from - 3_600_000 })).toEqual([])
    expect(wildEntries([ev(from + 10_000)], 's-1', { from, to: from + 3_600_000 }).map(e => e.at)).toEqual([from + 10_000])
  })

  it('a step bracket whose end was read before its start gives no count (steps.ts)', () => {
    const src = readFileSync(join(ROOT, 'src', 'chat', 'steps.ts'), 'utf8')
    expect(src).toMatch(/end\.at < usable\.at/)
  })
})

describe('drill: the transcript is deleted while its view is open', () => {
  it('the changes panel says gone and keeps no stale list; the edits cannot be read', async () => {
    const { vi } = await import('vitest')
    const { createLens } = require('../electron/chatLens.cjs')
    const { callKey } = require('../hooks/spawn-hook.cjs')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    try {
      const claudeDir = mkdtempSync(join(tmpdir(), 'spawn-chat-drill-gone-')); dirs.push(claudeDir)
      const userDataDir = mkdtempSync(join(tmpdir(), 'spawn-chat-drill-gone-ud-')); dirs.push(userDataDir)
      const PROJECT = 'C--Users-user-work-demo'
      fs.mkdirSync(join(claudeDir, 'projects', PROJECT), { recursive: true })
      fs.mkdirSync(join(userDataDir, 'session-links'), { recursive: true })
      const file = join(claudeDir, 'projects', PROJECT, `${T}.jsonl`)
      fs.copyFileSync(join(__dirname, 'fixtures', 'chat', 'changes.jsonl'), file)
      const updates: any[] = []
      const lens = createLens({ claudeDir, userDataDir, fs, emit: (u: any) => updates.push(u), callKey, watch: () => null, log: () => {} })
      const step = async (n: number) => { for (let k = 0; k < n; k++) { vi.advanceTimersByTime(10); await new Promise<void>(r => setImmediate(r)); await lens.idle() } }
      lens.setTerminals([{ id: T, cwd: 'C:\\Users\\user\\work\\demo', armed: true, status: 'running' }])
      lens.open(T)
      await step(100)
      let before = await lens.changes(T)
      for (let k = 0; k < 200 && !(before.ok && before.summary.state === 'ready'); k++) { await step(10); before = await lens.changes(T) }
      expect(before.ok).toBe(true)
      expect(before.files.length).toBeGreaterThan(0)
      fs.rmSync(file)
      const after = await lens.changes(T)
      expect(after).toMatchObject({ ok: true, summary: { state: 'gone' }, files: [] })
      expect(await lens.changeFile(T, 'src/math.js')).toEqual({ ok: false, reason: 'gone' })
      lens.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('drill: the transcript deleted — the panel\'s words', () => {
  it('gone: 세션 기록 파일을 찾지 못했어요 in place of the empty line (ko / en / ja)', () => {
    const src = readFileSync(join(ROOT, 'src', 'components', 'chat', 'ChangesPanel.tsx'), 'utf8')
    expect(src).toMatch(/summary\?\.state === 'gone' \? t\('세션 기록 파일을 찾지 못했어요'\) : t\('이 대화에서 바뀐 파일이 아직 없어요'\)/)
    expect(chat.en['세션 기록 파일을 찾지 못했어요']).toBeTruthy()
    expect(chat.ja['세션 기록 파일을 찾지 못했어요']).toBeTruthy()
  })
})

describe('drill (the Phase 6 trial): a refusal note never stays beside an image that did attach', () => {
  it('every image refusal is marked image; a successful attach clears only such a note', () => {
    const src = readFileSync(join(ROOT, 'src', 'components', 'chat', 'Composer.tsx'), 'utf8')
    const fn = src.slice(src.indexOf('function imageNote('), src.indexOf('\n}\n', src.indexOf('function imageNote(')))
    expect((fn.match(/return \{/g) ?? []).length).toBe((fn.match(/image: true/g) ?? []).length)
    expect(src).toMatch(/setChipList\(\[\.\.\.\(chipsOf\.get\(id\) \?\? \[\]\), \{ token: r\.token[^\n]*\n\s*setNote\(cur => \(cur\?\.image \? null : cur\)\)/)
  })
})
