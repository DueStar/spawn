/**
 * Terminal dialogs read from the screen and answered from the chat (src/chat/dialog.ts; 2026-11-17): the real
 * screens of 2.1.32x (a permission, the folder trust, a question, a plan) and the `/model` confirmation as the
 * owner's log showed its shape.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { answerDialog, parseDialog } from '../src/chat/dialog'

const screen = (name: string) => readFileSync(join(__dirname, 'fixtures', 'chat', 'screens', `${name}.txt`), 'utf8')

const MODEL = [
  '● 바꿨어요.',
  '',
  '✻ Cooked for 3s',
  '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
  '   Switch model?',
  '   This will clear the prompt cache for this conversation.',
  '',
  '   > 1. Yes, switch to Sonnet 5.5',
  '     2. No, keep Opus 5.5',
  '',
  '   Enter to confirm · Esc to cancel',
].join('\n')

describe('parseDialog', () => {
  it('a permission: its question, four options, the first marked, Esc offered', () => {
    const d = parseDialog(screen('dialog-bash'))!
    expect(d.title).toBe('Do you want to proceed?')
    expect(d.body).toContain('This command requires approval')
    expect(d.body).toContain('node -e "console.log(6*7)"')
    expect(d.options.map(o => o.label)).toEqual(['Yes', "Yes, and don't ask again for node commands in ~\\work\\demo", 'Yes, and switch to auto mode', 'No, and tell Claude what to do differently (esc)'])
    expect(d.selected).toBe(0)
    expect(d.options[3].free).toBe(true)
    expect(d.esc).toBe(true)
  })
  it('the folder trust and a question (descriptions under options)', () => {
    const trust = parseDialog(screen('dialog-trust'))!
    // (the question is the title, the line ending in ?; the rest stays the body, in order)
    expect(trust.title).toBe('Do you trust the files in this folder?')
    expect(trust.body[0]).toBe('C:\\Users\\user\\work\\demo')
    expect(trust.options.map(o => o.label)).toEqual(['Yes, proceed', 'No, exit'])
    const q = parseDialog(screen('dialog-question'))!
    expect(q.options.map(o => [o.label, o.desc, o.free])).toEqual([['JSON', ['Machine-readable, for scripts'], false], ['Markdown', ['Human-readable, for the README'], false], ['Type something.', [], true]])
    expect(q.hints[0]).toMatch(/^Enter to select/)
  })
  it('a plan: its choices; the option\'s own hint stays with it', () => {
    const p = parseDialog(screen('dialog-plan'))!
    expect(p.title).toMatch(/Would you like to proceed\?$/)
    expect(p.options.map(o => o.label)).toEqual(['Yes, and use auto mode', 'Yes, manually approve edits', 'Tell Claude what to change'])
    expect(p.options[2]).toMatchObject({ free: true, desc: ['shift+tab to approve with this feedback'] })
  })
  it('the /model confirmation (a > mark, a ▔ rule)', () => {
    const d = parseDialog(MODEL)!
    expect(d.title).toBe('Switch model?')
    expect(d.body).toEqual(['This will clear the prompt cache for this conversation.'])
    expect(d.options.map(o => o.label)).toEqual(['Yes, switch to Sonnet 5.5', 'No, keep Opus 5.5'])
    expect(d.selected).toBe(0)
  })
  it('no dialog: the prompt box, a numbered list in an answer', () => {
    expect(parseDialog(screen('idle-empty'))).toBeNull()
    expect(parseDialog(screen('real-named-session'))).toBeNull()
    expect(parseDialog('1. one\n2. two\n3. three')).toBeNull()
    expect(parseDialog(null)).toBeNull()
  })
  // 2026-11-19 (the owner's "the card no longer takes a choice after 터미널 → 채팅"): Claude Code 2.1.328 draws a rule
  // and "N. Chat about this" under a question's options (its binary: a divider, then `${n}. Chat about this`). The rule
  // broke the run of options, so a question handed back to the terminal never got its card from the screen
  it('a 2.1.328 question: the rule before "Chat about this" does not break the options; Type something takes words', () => {
    const q = parseDialog(screen('reconstructed-question-2.1.328'))!
    expect(q).not.toBeNull()
    expect(q.title).toBe('Which output format do you want?')
    expect(q.options.map(o => [o.label, o.desc, o.free])).toEqual([
      ['JSON', ['Machine-readable, for scripts'], false],
      ['Markdown', ['Human-readable, for the README'], false],
      ['Type something.', [], true],
      ['Chat about this', [], false],
    ])
    expect(q.selected).toBe(0)
    expect(q.esc).toBe(true)
  })
  it('a rule between options only once, right before the last: a numbered list under a rule in an answer is no dialog', () => {
    expect(parseDialog('1. one\n2. two\n──────────────────\n3. three')).toBeNull()
  })
})

/** A dialog that moves its mark with ↑ / ↓ and closes on Enter */
function term(text: string) {
  let lines = text.split('\n')
  const keys: string[] = []
  let pasted = ''
  const mark = () => lines.findIndex(l => /^\s*[❯>]\s*\d+\./.test(l))
  const opts = () => lines.map((l, i) => (/^\s*(?:[❯>]\s*)?\d+\.\s/.test(l) ? i : -1)).filter(i => i >= 0)
  const move = (dir: 1 | -1) => {
    const o = opts(); const at = o.indexOf(mark()); const to = o[Math.max(0, Math.min(o.length - 1, at + dir))]
    lines = lines.map((l, i) => (i === o[at] ? l.replace(/^(\s*)[❯>]\s*/, '$1  ') : i === to ? l.replace(/^(\s*)  /, '$1❯ ') : l))
  }
  return {
    keys, pasted: () => pasted,
    deps: {
      read: () => lines.join('\n') + (pasted ? `\n  ${pasted}` : ''),
      key: async (k: string) => { keys.push(k); if (k === 'down') move(1); if (k === 'up') move(-1); return true },
      paste: async (t: string) => { pasted = t; return true },
      sleep: async () => {},
    },
  }
}

describe('answerDialog', () => {
  it('moves the mark one step at a time, then Enter', async () => {
    const t = term(screen('dialog-bash'))
    expect(await answerDialog(2, t.deps)).toEqual({ ok: true })
    expect(t.keys).toEqual(['down', 'down', 'enter'])
  })
  it('the marked option: Enter only', async () => {
    const t = term(MODEL)
    expect(await answerDialog(0, t.deps)).toEqual({ ok: true })
    expect(t.keys).toEqual(['enter'])
  })
  it('words for a free option: pasted, seen, then Enter', async () => {
    const t = term(screen('dialog-question'))
    expect(await answerDialog(2, t.deps, 'YAML please')).toEqual({ ok: true })
    expect(t.keys).toEqual(['down', 'down', 'enter'])
    expect(t.pasted()).toBe('YAML please')
  })
  it('a 2.1.328 question (a rule over Chat about this): its Type something gets the words; its last row is reachable', async () => {
    const t = term(screen('reconstructed-question-2.1.328'))
    expect(await answerDialog(2, t.deps, 'YAML please')).toEqual({ ok: true })
    expect(t.keys).toEqual(['down', 'down', 'enter'])
    expect(t.pasted()).toBe('YAML please')
    const u = term(screen('reconstructed-question-2.1.328'))
    expect(await answerDialog(3, u.deps)).toEqual({ ok: true })
    expect(u.keys).toEqual(['down', 'down', 'down', 'enter'])
  })
  it('a mark that does not move, or no dialog: nothing more pressed', async () => {
    const keys: string[] = []
    const stuck = { read: () => screen('dialog-bash'), key: async (k: string) => { keys.push(k); return true }, paste: async () => true, sleep: async () => {} }
    expect(await answerDialog(1, stuck, undefined, { stepMs: 10, waitMs: 30 })).toEqual({ ok: false, reason: 'gone' })
    expect(keys).toEqual(['down'])
    expect(await answerDialog(0, { ...stuck, read: () => screen('idle-empty') })).toEqual({ ok: false, reason: 'gone' })
  })
})

/**
 * A panel's plain rows (2026-11-19, the owner's /rc): the /remote-control panel as the 2.1.328 binary draws it —
 * RECONSTRUCTED from the binary's strings and layout (title, the sentence with the session's link, the rows
 * Disconnect · Show QR code (its dim line) · Continue, the last one focused, no key hints), not a captured screen.
 */
describe('parseDialog: plain rows', () => {
  it('the /remote-control panel: its title, its link whole (wrapped on the screen), three rows, Continue marked, no Esc hint', () => {
    const d = parseDialog(screen('reconstructed-rc-panel'))!
    expect(d).not.toBeNull()
    expect(d.numbered).toBe(false)
    expect(d.title).toBe('Remote Control')
    expect(d.body[0]).toMatch(/^This session is available in the Claude mobile app/)
    expect(d.links).toEqual(['https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv'])
    expect(d.options.map(o => [o.n, o.label, o.desc])).toEqual([
      [1, 'Disconnect this session', []],
      [2, 'Show QR code', ['Scan with your phone to open this session']],
      [3, 'Continue', []],
    ])
    expect(d.selected).toBe(2)
    expect(d.esc).toBe(false)
    expect(d.options.every(o => !o.free)).toBe(true)
  })
  it('a panel with a hint line under its rows: Esc offered', () => {
    const d = parseDialog([
      '────────────────────────────────────────',
      ' Manage MCP servers',
      '',
      ' ❯ figma · ✔ connected',
      '   memory · ✔ connected',
      '',
      ' ↑↓ to navigate · Enter to select · Esc to close',
    ].join('\n'))!
    expect(d.title).toBe('Manage MCP servers')
    expect(d.options.map(o => o.label)).toEqual(['figma · ✔ connected', 'memory · ✔ connected'])
    expect(d.selected).toBe(0)
    expect(d.esc).toBe(true)
  })
  it('the numbered dialogs read as before (numbered, their links)', () => {
    expect(parseDialog(screen('dialog-bash'))!.numbered).toBe(true)
    expect(parseDialog(screen('dialog-trust'))!.links).toEqual([])
  })
  it('no dialog: the prompt box, a typed prompt, a reply, a list in prose, a quote', () => {
    for (const name of ['idle-empty', 'idle-placeholder', 'typed', 'typed-multiline', 'working-empty', 'real-named-session', 'real-agents-panel', 'real-ascii-mark', 'after-turn-suggestion', 'narrow-wrap', 'real-history-recall', 'echo-plain', 'echo-korean']) {
      expect(parseDialog(screen(name)), name).toBeNull()
    }
    // a multi-line prompt echoed above Claude's reply (its lines sit where rows would)
    expect(parseDialog(['● Earlier answer.', '', '❯ fix the login page', '  and the signup page', '  then run the tests', '', '● On it.'].join('\n'))).toBeNull()
    // the same as the last thing on the screen, with no rule over it
    expect(parseDialog(['● Earlier answer.', '', '❯ fix the login page', '  and the signup page', '  then run the tests'].join('\n'))).toBeNull()
    // Claude's prose: a bulleted list, a quote, with a rule (a table's) over it
    expect(parseDialog(['──────────────────────', '  Options:', '', '  - first', '  > second', '  - third'].join('\n'))).toBeNull()
    expect(parseDialog(['────────────────────────', ' Pick one', '', ' > Alpha', '   Beta', '', ' That is all I have for now.'].join('\n'))).toBeNull()
    // one row only
    expect(parseDialog(['────────────────────────', ' Remote Control', '', ' ❯ Continue'].join('\n'))).toBeNull()
  })
})

/** A panel of plain rows that moves its ❯ with ↑ / ↓ (rows: one space, then the mark or two spaces, then a capital) */
function rowsTerm(text: string) {
  let lines = text.replace(/\r/g, '').split('\n')
  const keys: string[] = []
  const rows = () => lines.map((l, i) => (/^ (?:❯ | {2})[A-Z]/.test(l) ? i : -1)).filter(i => i >= 0)
  const move = (dir: 1 | -1) => {
    const r = rows()
    const at = r.findIndex(i => lines[i].startsWith(' ❯ '))
    const to = r[Math.max(0, Math.min(r.length - 1, at + dir))]
    lines = lines.map((l, i) => (i === r[at] ? `   ${l.slice(3)}` : i === to ? ` ❯ ${l.slice(3)}` : l))
  }
  return {
    keys,
    deps: {
      read: () => lines.join('\n'),
      key: async (k: string) => { keys.push(k); if (k === 'down') move(1); if (k === 'up') move(-1); return true },
      paste: async () => true,
      sleep: async () => {},
    },
  }
}

describe('answerDialog: plain rows', () => {
  it('moves up from Continue to Disconnect one step at a time, then Enter', async () => {
    const t = rowsTerm(screen('reconstructed-rc-panel'))
    expect(await answerDialog(0, t.deps)).toEqual({ ok: true })
    expect(t.keys).toEqual(['up', 'up', 'enter'])
  })
  it('the marked row: Enter only', async () => {
    const t = rowsTerm(screen('reconstructed-rc-panel'))
    expect(await answerDialog(2, t.deps)).toEqual({ ok: true })
    expect(t.keys).toEqual(['enter'])
  })
})
