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
    expect(trust.title).toMatch(/only use files from trusted sources/)
    expect(trust.body[0]).toBe('Do you trust the files in this folder?')
    expect(trust.options.map(o => o.label)).toEqual(['Yes, proceed', 'No, exit'])
    const q = parseDialog(screen('dialog-question'))!
    expect(q.options.map(o => [o.label, o.desc, o.free])).toEqual([['JSON', ['Machine-readable, for scripts'], false], ['Markdown', ['Human-readable, for the README'], false], ['Type something.', [], true]])
    expect(q.hints[0]).toMatch(/^Enter to select/)
  })
  it('a plan: its choices; the option\'s own hint stays with it', () => {
    const p = parseDialog(screen('dialog-plan'))!
    expect(p.title).toMatch(/ready to execute/)
    expect(p.options.map(o => o.label)).toEqual(['Yes, and use auto mode', 'Yes, manually approve edits', 'Tell Claude what to change'])
    expect(p.options[2]).toMatchObject({ free: true, desc: ['shift+tab to approve with this feedback'] })
  })
  it('the /model confirmation (a > mark, a ▔ rule)', () => {
    const d = parseDialog(MODEL)!
    expect(d.title).toBe('This will clear the prompt cache for this conversation.')
    expect(d.body).toEqual(['Switch model?'])
    expect(d.options.map(o => o.label)).toEqual(['Yes, switch to Sonnet 5.5', 'No, keep Opus 5.5'])
    expect(d.selected).toBe(0)
  })
  it('no dialog: the prompt box, a numbered list in an answer', () => {
    expect(parseDialog(screen('idle-empty'))).toBeNull()
    expect(parseDialog(screen('real-named-session'))).toBeNull()
    expect(parseDialog('1. one\n2. two\n3. three')).toBeNull()
    expect(parseDialog(null)).toBeNull()
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
  it('a mark that does not move, or no dialog: nothing more pressed', async () => {
    const keys: string[] = []
    const stuck = { read: () => screen('dialog-bash'), key: async (k: string) => { keys.push(k); return true }, paste: async () => true, sleep: async () => {} }
    expect(await answerDialog(1, stuck, undefined, { stepMs: 10, waitMs: 30 })).toEqual({ ok: false, reason: 'gone' })
    expect(keys).toEqual(['down'])
    expect(await answerDialog(0, { ...stuck, read: () => screen('idle-empty') })).toEqual({ ok: false, reason: 'gone' })
  })
})
