/**
 * `!` commands (Claude Code's bash mode) in the chat view: the record's two user lines as one shell row, and the
 * composer's shell send (the `!` pasted only when the user chose shell mode; a plain `!` stays literal).
 */
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { itemProblems } from './chat-helpers'

const require = createRequire(import.meta.url)
const { createItemBuilder } = require('../electron/chatItems.cjs')
const { encodeSend } = require('../electron/chatInput.cjs')

const user = (uuid: string, content: string) => ({ type: 'user', uuid, timestamp: '2026-11-17T05:00:00.000Z', message: { role: 'user', content } })

describe('the record: a ! command and its output', () => {
  it('two lines, one shell row', () => {
    const b = createItemBuilder({ cwd: 'C:\\w' })
    const [first] = b.line(user('u1', '<bash-input>git status</bash-input>'), 10)
    expect(first).toMatchObject({ id: 'u1', kind: 'shell', command: 'git status', state: 'running' })
    const [done] = b.line(user('u2', '<bash-stdout>On branch main\n&gt; clean</bash-stdout><bash-stderr></bash-stderr>'), 20)
    expect(done).toMatchObject({ id: 'u1', order: 10, kind: 'shell', command: 'git status', state: 'done', stdout: 'On branch main\n> clean' })
    expect(done.stderr).toBeUndefined()
    expect(itemProblems(done)).toEqual([])
  })
  it('no output, and an error', () => {
    const b = createItemBuilder({ cwd: 'C:\\w' })
    b.line(user('u1', '<bash-input> gh pr merge 1</bash-input>'), 10)
    const [quiet] = b.line(user('u2', '<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr></bash-stderr>'), 20)
    expect(quiet).toMatchObject({ kind: 'shell', command: 'gh pr merge 1', state: 'done' })
    expect(quiet.stdout).toBeUndefined()
    b.line(user('u3', '<bash-input>bad</bash-input>'), 30)
    const [err] = b.line(user('u4', '<bash-stdout></bash-stdout><bash-stderr>accepts at most 1 arg(s)\n</bash-stderr>'), 40)
    expect(err).toMatchObject({ id: 'u3', stderr: 'accepts at most 1 arg(s)' })
  })
  it('an output line with no command seen (the record read from its end): nothing', () => {
    const b = createItemBuilder({ cwd: 'C:\\w' })
    expect(b.line(user('u2', '<bash-stdout>x</bash-stdout><bash-stderr></bash-stderr>'), 20)).toEqual([])
  })
  it('a prompt that merely mentions the tag is a user message', () => {
    const b = createItemBuilder({ cwd: 'C:\\w' })
    expect(b.line(user('u1', 'what does <bash-input> mean?'), 10)[0]).toMatchObject({ kind: 'user' })
  })
})

describe('the send', () => {
  it('shell mode pastes the ! (bash mode), and the echo head carries it', () => {
    const enc = encodeSend({ text: 'git status', shell: true })
    expect(enc.steps[0].data).toBe('\x1b[200~!git status\x1b[201~')
    expect(enc.expect.head).toBe('!git status')
    expect(enc.command).toBe(false)
  })
  it('a ! typed in the normal composer stays literal (a leading space)', () => {
    expect(encodeSend({ text: '!git status' }).steps[0].data).toBe('\x1b[200~ !git status\x1b[201~')
  })
  it('shell mode never sends images, and a slash in it is not a command', () => {
    const enc = encodeSend({ text: '/usr/bin/ls', shell: true, images: ['C:\\a.png'] })
    expect(enc.steps).toHaveLength(1)
    expect(enc.expect.head).toBe('!/usr/bin/ls')
  })
})
