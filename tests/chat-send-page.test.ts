/**
 * src/chat/send.ts — the page's half of a send: refuse locally what main would refuse anyway
 * (the session waits on the user, the prompt row cannot be read, a send already running), the
 * provisional bubble, chat.send, the echo watched on the page's own screen, chat.submit with
 * what was seen. Nothing is retried. A fake bridge and scripted screens.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isCommandText, sendDraft, wellFormed, type SendDeps } from '../src/chat/send'
import { echoState } from '../src/chat/promptRow'
import { createOutbox } from '../src/chat/outbox'
import type { LensStatus } from '../src/chat/types'
import { maskOf } from './dim-mask'

const require = createRequire(import.meta.url)
const { isCommand } = require('../electron/chatInput.cjs')

const screen = (name: string) => readFileSync(join(__dirname, 'fixtures', 'chat', 'screens', `${name}.txt`), 'utf8')
const STATUS: LensStatus = { state: 'idle', since: null, label: null, banner: null, note: null, version: null, hasOlder: false, empty: false }
const T1 = '11111111-1111-4111-8111-111111111111'

function deps(screens: (string | null)[], answers: { send?: any; submit?: any } = {}) {
  let clock = 0
  const calls: { fn: string; arg: any }[] = []
  const outbox = createOutbox({ revoke: () => {} })
  let n = 0
  const d: SendDeps = {
    bridge: {
      send: async (p) => { calls.push({ fn: 'send', arg: p }); return answers.send ?? { ok: true, expect: { head: 'Without tools, name thre', images: 0, long: false }, command: false } },
      submit: async (p) => { calls.push({ fn: 'submit', arg: p }); return answers.submit ?? { ok: true } },
    },
    readScreen: () => { const s = screens.length > 1 ? screens.shift()! : screens[0]; return s },
    now: () => clock,
    sleep: async (ms) => { clock += ms },
    outbox,
    newId: () => `send-test-${++n}`,
    status: STATUS,
    baseline: 100,
  }
  return { d, calls, outbox, clock: () => clock }
}

describe('sendDraft', () => {
  it('the happy path: one send with the screen\'s verdict, the echo, one submit with ok; the bubble is sent', async () => {
    const t = deps([screen('idle-empty'), screen('idle-empty'), screen('echo-plain')])
    const r = await sendDraft({ id: T1, text: 'Without tools, name three rivers', images: [] }, t.d)
    expect(r).toEqual({ ok: true, command: false })
    expect(t.calls.map(c => c.fn)).toEqual(['send', 'submit'])
    expect(t.calls[0].arg).toEqual({ id: T1, sendId: 'send-test-1', text: 'Without tools, name three rivers', images: [], screen: 'empty' })
    expect(t.calls[1].arg).toEqual({ id: T1, sendId: 'send-test-1', echo: 'ok' })
    expect(t.outbox.entries().map(e => [e.state, e.text, e.baseline])).toEqual([['sent', 'Without tools, name three rivers', 100]])
  })

  it('a dialog on the screen: refused here, no IPC, no bubble', async () => {
    const t = deps([screen('dialog-bash')])
    expect(await sendDraft({ id: T1, text: 'hi', images: [] }, t.d)).toEqual({ ok: false, reason: 'screen', leftOnPrompt: false })
    expect(t.calls).toEqual([])
    expect(t.outbox.entries()).toEqual([])
  })

  it('the session waits on the user: refused here', async () => {
    const t = deps([screen('idle-empty')])
    t.d.status = { ...STATUS, state: 'waiting' }
    expect(await sendDraft({ id: T1, text: 'hi', images: [] }, t.d)).toEqual({ ok: false, reason: 'waiting', leftOnPrompt: false })
    expect(t.calls).toEqual([])
  })

  it('the echo shows something else: submit says mismatch at once, the text is left on the prompt row', async () => {
    const t = deps([screen('idle-empty'), screen('echo-after-suggestion')], { submit: { ok: false, reason: 'no-echo' } })
    const r = await sendDraft({ id: T1, text: 'Without tools, name three rivers', images: [] }, t.d)
    expect(r).toEqual({ ok: false, reason: 'no-echo', leftOnPrompt: true })
    expect(t.calls[1].arg.echo).toBe('mismatch')
    expect(t.clock()).toBeLessThan(200)
    expect(t.outbox.entries()).toEqual([])
  })

  it('a dialog appears after the paste: blocked at once', async () => {
    const t = deps([screen('idle-empty'), screen('dialog-edit')], { submit: { ok: false, reason: 'no-echo' } })
    await sendDraft({ id: T1, text: 'hi', images: [] }, t.d)
    expect(t.calls[1].arg.echo).toBe('blocked')
  })

  it('no echo: the wait is 1.5 s, + 500 ms an image; then timeout', async () => {
    const t = deps([screen('idle-empty'), screen('idle-empty')], { submit: { ok: false, reason: 'no-echo' } })
    await sendDraft({ id: T1, text: 'hi', images: [] }, t.d)
    expect(t.calls[1].arg.echo).toBe('timeout')
    expect(t.clock()).toBeGreaterThanOrEqual(1500)
    expect(t.clock()).toBeLessThan(1600)
    const u = deps([screen('idle-empty'), screen('echo-image-pending')], { send: { ok: true, expect: { head: 'what is in this picture?', images: 2, long: false }, command: false }, submit: { ok: false, reason: 'no-echo' } })
    await sendDraft({ id: T1, text: 'what is in this picture?', images: [{ token: 'a'.repeat(24), url: 'blob:a' }, { token: 'b'.repeat(24), url: 'blob:b' }] }, u.d)
    expect(u.calls[0].arg.images).toEqual(['a'.repeat(24), 'b'.repeat(24)])
    expect(u.calls[1].arg.echo).toBe('timeout')
    expect(u.clock()).toBeGreaterThanOrEqual(2500)
    expect(u.clock()).toBeLessThan(2600)
  })

  it('send refused by main: the bubble goes, nothing left on the prompt row', async () => {
    const t = deps([screen('typed')], { send: { ok: false, reason: 'prompt-busy' } })
    expect(await sendDraft({ id: T1, text: 'hi', images: [] }, t.d)).toEqual({ ok: false, reason: 'prompt-busy', leftOnPrompt: false, row: 'add a mul function' })
    expect(t.calls.map(c => c.fn)).toEqual(['send'])
    expect(t.calls[0].arg.screen).toBe('text')
    expect(t.outbox.entries()).toEqual([])
  })

  it('1.6.2: with the dim mask, a suggestion goes as `suggestion` and typed text as `typed`', async () => {
    const sug = screen('after-turn-suggestion').replace(/\n$/, '')
    const t = deps([sug], { send: { ok: false, reason: 'empty' } })
    t.d.readDim = () => maskOf(sug, true)
    await sendDraft({ id: T1, text: 'hi', images: [] }, t.d)
    expect(t.calls[0].arg.screen).toBe('suggestion')
    const typed = screen('typed').replace(/\n$/, '')
    const u = deps([typed], { send: { ok: false, reason: 'prompt-busy' } })
    u.d.readDim = () => maskOf(typed)
    expect(await sendDraft({ id: T1, text: 'hi', images: [] }, u.d)).toEqual({ ok: false, reason: 'prompt-busy', leftOnPrompt: false, row: 'add a mul function' })
    expect(u.calls[0].arg.screen).toBe('typed')
  })

  it('1.6.2: main\'s prompt-busy or prompt-unknown is logged once with the masked screen and its dim marks (~)', async () => {
    const typed = screen('typed').replace(/\n$/, '')
    for (const reason of ['prompt-busy', 'prompt-unknown']) {
      const t = deps([typed], { send: { ok: false, reason } })
      const diags: any[] = []
      t.d.bridge.diag = (p) => { diags.push(p) }
      t.d.readDim = () => maskOf(typed)
      await sendDraft({ id: T1, text: 'hi', images: [] }, t.d)
      expect(diags).toHaveLength(1)
      expect(diags[0].why).toBe(reason)
      expect(diags[0].shape).not.toContain('mul')
      expect(diags[0].shape).toContain('-- dim --')
    }
  })

  it('a slash command: no bubble; command: true', async () => {
    const t = deps([screen('idle-empty'), (() => screen('typed').replace('❯ add a mul function', '❯ /compact'))()], { send: { ok: true, expect: { head: '/compact', images: 0, long: false }, command: true } })
    expect(await sendDraft({ id: T1, text: '/compact', images: [] }, t.d)).toEqual({ ok: true, command: true })
    expect(t.outbox.entries()).toEqual([])
  })

  it('two at once for one terminal: the second refused here, without IPC', async () => {
    const t = deps([screen('idle-empty'), screen('echo-plain')])
    const a = sendDraft({ id: T1, text: 'Without tools, name three rivers', images: [] }, t.d)
    const b = await sendDraft({ id: T1, text: 'again', images: [] }, t.d)
    expect(b).toEqual({ ok: false, reason: 'sending', leftOnPrompt: false })
    await a
    expect(t.calls.filter(c => c.fn === 'send')).toHaveLength(1)
  })

  it('the bridge throwing: said as a refusal, never retried', async () => {
    const t = deps([screen('idle-empty'), screen('echo-plain')])
    t.d.bridge.send = async () => { throw new Error('ipc gone') }
    expect(await sendDraft({ id: T1, text: 'hi', images: [] }, t.d)).toEqual({ ok: false, reason: 'no-session', leftOnPrompt: false })
    const u = deps([screen('idle-empty'), screen('echo-plain')])
    u.d.bridge.submit = async () => { throw new Error('ipc gone') }
    expect(await sendDraft({ id: T1, text: 'Without tools, name three rivers', images: [] }, u.d)).toEqual({ ok: false, reason: 'no-session', leftOnPrompt: true })
  })

  it('the page\'s command test is main\'s', () => {
    for (const s of ['/compact', '/compact now', '/usr/bin is slow', '/ x', '//x', '/a\tb', '/x\ny', 'hi', '/plugin:do-it', '']) expect(isCommandText(s), JSON.stringify(s)).toBe(isCommand(s))
  })
})

describe('the review of Phase 3: the page\'s half (fixed)', () => {
  it('I-6: once the echo is right, the page waits out main\'s minimum and reads the screen once more; a dialog that opened meanwhile: blocked, no Enter asked', async () => {
    // reads: preflight, the echo (right at once), then the screen again after the wait
    const t = deps([screen('idle-empty'), screen('echo-plain'), screen('dialog-question')], { send: { ok: true, expect: { head: 'Without tools, name thre', images: 0, long: false }, command: false, minEnterMs: 150 }, submit: { ok: false, reason: 'no-echo' } })
    const r = await sendDraft({ id: T1, text: 'Without tools, name three rivers', images: [] }, t.d)
    expect(t.calls[1].arg.echo).toBe('blocked')
    expect(r).toEqual({ ok: false, reason: 'no-echo', leftOnPrompt: true })
    // the submit is asked only after the minimum (and a margin), never before
    const u = deps([screen('idle-empty'), screen('echo-plain')], { send: { ok: true, expect: { head: 'Without tools, name thre', images: 1, long: false }, command: false, minEnterMs: 400 } })
    let at = -1
    u.d.bridge.submit = async (p) => { at = u.clock(); return { ok: true } }
    u.d.readScreen = () => screen('echo-plain').replace('❯ Without tools, name three rivers', '❯ Without tools, name three rivers [Image #1]')
    await sendDraft({ id: T1, text: 'Without tools, name three rivers', images: [{ token: 'a'.repeat(24), url: 'blob:a' }] }, u.d)
    expect(at).toBeGreaterThanOrEqual(400)
  })

  it('m3: main\'s answer decides whether a bubble shows (a command has none), not the page\'s guess', async () => {
    // the page guesses "not a command" (a control character in front), main says it is one
    const t = deps([screen('idle-empty'), (() => screen('typed').replace('❯ add a mul function', '❯ /compact'))()], { send: { ok: true, expect: { head: '/compact', images: 0, long: false }, command: true } })
    expect(await sendDraft({ id: T1, text: '\u0007/compact', images: [] }, t.d)).toEqual({ ok: true, command: true })
    expect(t.outbox.entries()).toEqual([])
    // and the other way: main pasted it as text, the bubble shows
    const u = deps([screen('idle-empty'), screen('echo-plain')], { send: { ok: true, expect: { head: 'Without tools, name thre', images: 0, long: false }, command: false } })
    await sendDraft({ id: T1, text: '/Without tools, name three rivers\nx', images: [] }, u.d)
    expect(u.outbox.entries()).toHaveLength(1)
  })

  it('m4: the bubble shows a lone surrogate as the terminal does (U+FFFD); I-2: without the blank lines before the text', async () => {
    expect(wellFormed('a\ud800b')).toBe('a\ufffdb')
    const t = deps([screen('idle-empty'), screen('echo-plain')])
    await sendDraft({ id: T1, text: '\n\nWithout tools, name three rivers \ud800', images: [] }, t.d)
    expect(t.outbox.entries()[0].text).toBe('Without tools, name three rivers \ufffd')
  })

  it('m8: slow screen reads never make the page outlast main: the echo wait ends at twice its limit by the clock too', async () => {
    const t = deps([screen('idle-empty'), screen('idle-empty')], { submit: { ok: false, reason: 'no-echo' } })
    // each read of the screen takes 200 ms of wall time
    const read = t.d.readScreen
    let clock = 0
    t.d.now = () => clock
    t.d.sleep = async (ms) => { clock += ms }
    t.d.readScreen = (id) => { clock += 200; return read(id) }
    await sendDraft({ id: T1, text: 'hi', images: [] }, t.d)
    expect(t.calls[1].arg.echo).toBe('timeout')
    // (the read before the send, the wait at twice the limit, the read that ended it: under main's 4.3 s)
    expect(clock).toBeLessThanOrEqual(200 + 2 * 1500 + 2 * 200)
  })

  it('I-2: images alone: the row must be exactly their markers; a stale marker or any text before them is a mismatch', () => {
    const row = (txt: string) => screen('echo-image').replace('❯ what is in this picture? [Image #1]', '❯ ' + txt)
    expect(echoState(row('[Image #1]'), { head: '', images: 1, long: false })).toBe('ok')
    expect(echoState(row('[Image #1] [Image #2]'), { head: '', images: 1, long: false })).toBe('mismatch')
    expect(echoState(row('stale words [Image #1]'), { head: '', images: 1, long: false })).toBe('mismatch')
    // no head and no image: never ok
    expect(echoState(row('stale words the ledger never heard'), { head: '', images: 0, long: true })).toBe('mismatch')
  })

  it('the hint and the command guess drop blank lines first, as main does', () => {
    expect(isCommandText('\n/compact')).toBe(true)
    expect(isCommandText('\n/usr/bin is slow\nmore')).toBe(false)
  })
})
