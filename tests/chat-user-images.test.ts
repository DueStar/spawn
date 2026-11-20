/**
 * electron/chatFull.cjs readUserImage — a picture the user sent, read again from that message's own
 * transcript line when its row is drawn: the n-th image block, decoded; picture types only, capped.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { readUserImage } = require('../electron/chatFull.cjs')

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])
const img = (b: Buffer, media: string) => ({ type: 'image', source: { type: 'base64', media_type: media, data: b.toString('base64') } })

const dir = mkdtempSync(join(tmpdir(), 'chat-user-images-'))
const file = join(dir, 't.jsonl')
const first = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } })
const second = JSON.stringify({ type: 'user', message: { role: 'user', content: [img(PNG, 'image/png'), { type: 'text', text: 'compare' }, img(JPG, 'image/jpeg')] } })
const third = JSON.stringify({ type: 'user', message: { role: 'user', content: [img(Buffer.from('<svg/>'), 'image/svg+xml')] } })
writeFileSync(file, `${first}\n${second}\n${third}\n`)
const at2 = Buffer.byteLength(first) + 1
const at3 = at2 + Buffer.byteLength(second) + 1
const user = (order: number, images: number) => ({ id: 'u', kind: 'user', order, images, text: '' })

describe('readUserImage', () => {
  it('the n-th picture of the message, in order, with its type', async () => {
    const a = await readUserImage(fs.promises, file, user(at2, 2), 0)
    expect(a).toMatchObject({ ok: true, type: 'image/png' })
    expect(Buffer.from(a.bytes).equals(PNG)).toBe(true)
    const b = await readUserImage(fs.promises, file, user(at2, 2), 1)
    expect(b).toMatchObject({ ok: true, type: 'image/jpeg' })
    expect(Buffer.from(b.bytes).equals(JPG)).toBe(true)
  })
  it('none past the last, none on a line without pictures, none for a type that is not a picture', async () => {
    expect(await readUserImage(fs.promises, file, user(at2, 2), 2)).toEqual({ ok: false, reason: 'gone' })
    expect(await readUserImage(fs.promises, file, user(0, 1), 0)).toEqual({ ok: false, reason: 'gone' })
    expect(await readUserImage(fs.promises, file, user(at3, 1), 0)).toEqual({ ok: false, reason: 'type' })
  })
  it('only a user message of the main thread; a big picture is refused', async () => {
    expect(await readUserImage(fs.promises, file, { ...user(at2, 2), kind: 'text' }, 0)).toEqual({ ok: false, reason: 'unknown' })
    expect(await readUserImage(fs.promises, file, { ...user(at2, 2), parent: 'agent' }, 0)).toEqual({ ok: false, reason: 'unknown' })
    expect(await readUserImage(fs.promises, file, user(at2, 2), 0, 4)).toEqual({ ok: false, reason: 'size' })
  })
})
