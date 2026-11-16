/**
 * What the Phase 3 trial on a real session (Claude Code 2.1.325, Windows) showed that the
 * hand-written fixtures had guessed wrong. Each fixture here is a real screen's shape, redacted by
 * hand (tests/fixtures/chat/screens/real-*.txt).
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { echoState, promptRow } from '../src/chat/promptRow'

const screen = (name: string) => readFileSync(join(__dirname, 'fixtures', 'chat', 'screens', `${name}.txt`), 'utf8')

describe('the prompt mark is followed by a no-break space (U+00A0), not a space', () => {
  it('the first-run placeholder and an empty prompt are read as the prompt box', () => {
    expect(screen('real-placeholder-nbsp')).toContain('❯\u00a0Try')
    expect(promptRow(screen('real-placeholder-nbsp'))).toEqual({ kind: 'text', text: 'Try "refactor <filepath>"' })
    expect(promptRow(screen('real-idle-empty-nbsp'))).toEqual({ kind: 'empty' })
  })
  it('the echo of a send is seen there', () => {
    const s = screen('real-idle-empty-nbsp').replace('❯\u00a0', '❯\u00a0Without tools, name three rivers')
    expect(echoState(s, { head: 'Without tools, name thre', images: 0, long: false })).toBe('ok')
  })
})

describe('the echo poll\'s first reads come before Claude Code has drawn the paste', () => {
  // the trial: a send over the first-run placeholder ended "mismatch" 32 ms after the paste, because
  // the row still showed the placeholder; a moment later it showed the pasted text alone
  const placeholder = screen('real-placeholder-nbsp')
  const pasted = placeholder.replace('Try "refactor <filepath>"', 'Without tools, name three rivers in one short line.')
  const expectRow = { head: 'Without tools, name thre', images: 0, long: false }

  it('a row unchanged since the send was asked for is not an answer yet (pending), not a mismatch', () => {
    expect(echoState(placeholder, expectRow, 'Try "refactor <filepath>"')).toBe('pending')
    expect(echoState(pasted, expectRow, 'Try "refactor <filepath>"')).toBe('ok')
    // the paste appended to what was there: the row changed, and does not start with the text
    expect(echoState(placeholder.replace('Try "refactor <filepath>"', 'Try "refactor <filepath>"Without tools'), expectRow, 'Try "refactor <filepath>"')).toBe('mismatch')
  })

  it('sendDraft passes the row it read before sending', async () => {
    const { sendDraft } = await import('../src/chat/send')
    const { createOutbox } = await import('../src/chat/outbox')
    const reads = [placeholder, placeholder, placeholder, pasted]
    let clock = 0
    const calls: any[] = []
    const r = await sendDraft({ id: 'T', text: 'Without tools, name three rivers in one short line.', images: [] }, {
      bridge: { send: async () => ({ ok: true, expect: expectRow, command: false, minEnterMs: 150 }), submit: async (p) => { calls.push(p); return { ok: true } } },
      readScreen: () => (reads.length > 1 ? reads.shift()! : reads[0]), now: () => clock, sleep: async (ms) => { clock += ms },
      outbox: createOutbox({ revoke: () => {} }), newId: () => 'send-real-0001', status: null, baseline: 0,
    })
    expect(r).toEqual({ ok: true, command: false })
    expect(calls[0].echo).toBe('ok')
  })
})

describe('a long paste is recorded wrapped in <pasted_content id="…"> tags', () => {
  // the trial: a 61-line send was right in the terminal ([Pasted text #1 +60 lines]) and submitted once,
  // but the transcript's user line held `\n\n<pasted_content id="fe19">\n…\n</pasted_content id="fe19">\n`:
  // the chat showed the tags and the bubble never matched it (unconfirmed after 8 s)
  const req = createRequire(import.meta.url)
  const { createItemBuilder } = req('../electron/chatItems.cjs')
  const lines = readFileSync(join(__dirname, 'fixtures', 'chat', 'pasted.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const users = () => { const b = createItemBuilder({ cwd: 'C:\\Users\\user\\work\\demo' }); return lines.flatMap((o, i) => b.line(o, i * 1000)).filter((i: any) => i.kind === 'user') }

  it('the user item is the pasted text itself, without the tags', () => {
    const [one, two, three] = users()
    expect(one.text.startsWith('Count the lines below')).toBe(true)
    expect(one.text.endsWith('line 60 of a long pasted list')).toBe(true)
    expect(one.text).not.toContain('pasted_content')
    expect(two.text).toBe('look at this: one\ntwo\n and say ok')
    // a prompt that only mentions the word keeps it
    expect(three.text).toBe('a prompt that mentions <pasted_content> in passing')
  })

  it('the bubble matches that line', async () => {
    const { sentMatches } = await import('../src/chat/outbox')
    let sent = 'Count the lines below and reply with only the number.'
    for (let i = 1; i <= 60; i++) sent += '\nline ' + i + ' of a long pasted list'
    expect(sentMatches(sent, users()[0].text)).toBe(true)
  })
})

describe('a prompt recalled with ↑ in the terminal: the box\'s top rule carries a label', () => {
  // the trial: "─── History 33/33 ───…" above the row; read as no box, the composer refused with
  // the vague "couldn't confirm"; it is the prompt box, holding text the ledger cannot place
  it('is the prompt box with that text (the ledger then says prompt-unknown in main)', () => {
    expect(promptRow(screen('real-history-recall'))).toEqual({ kind: 'text', text: 'Reply with the single word: yes.' })
  })
  it('a labelled rule at the bottom, or a dialog\'s dashed rule, is still not a box', () => {
    const s = screen('real-history-recall').split('\n')
    const swapped = [...s.slice(0, 4), s[6], s[5], s[4], ...s.slice(7)].join('\n')
    expect(promptRow(swapped).kind).toBe('unknown')
  })
})
