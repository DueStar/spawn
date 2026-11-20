/**
 * electron/chatPictures.cjs — a picture the conversation names, read for the chat view:
 * picture extensions only, named by the session's own items, at most 8 MB.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { readPicture, namedIn, PICTURE_TYPES } = require('../electron/chatPictures.cjs')

const dir = mkdtempSync(join(tmpdir(), 'chat-pictures-'))
const png = join(dir, 'shot one.png')
writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]))
const txt = join(dir, 'notes.txt')
writeFileSync(txt, 'secret')
const items = [
  { kind: 'tool', tool: 'Read', input: { file_path: png } },
  { kind: 'text', text: 'see notes' },
]

describe('namedIn', () => {
  it('finds a path in any string of the items, nested', () => {
    expect(namedIn(items, png)).toBe(true)
    expect(namedIn([{ kind: 'tool', tool: 'SendUserFile', input: { files: ['x', png] } }], png)).toBe(true)
    expect(namedIn([{ kind: 'text', text: `the shot is at ${png}.` }], png)).toBe(true)
  })
  it('a path no item names, or an empty one, is not named', () => {
    expect(namedIn(items, join(dir, 'other.png'))).toBe(false)
    expect(namedIn(items, '')).toBe(false)
  })
})

describe('readPicture', () => {
  const named = (p: string) => namedIn(items, p)
  it('a named picture: its bytes and type', async () => {
    const r = await readPicture(fs.promises, { path: png, named })
    expect(r).toMatchObject({ ok: true, type: 'image/png' })
    expect(Array.from(r.bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
  })
  it('refuses what is not a picture, a path the items do not name, a missing file, a big one', async () => {
    expect(await readPicture(fs.promises, { path: txt, named: () => true })).toEqual({ ok: false, reason: 'type' })
    expect(await readPicture(fs.promises, { path: join(dir, 'x.png'), named })).toEqual({ ok: false, reason: 'unnamed' })
    expect(await readPicture(fs.promises, { path: join(dir, 'gone.png'), named: () => true })).toEqual({ ok: false, reason: 'missing' })
    expect(await readPicture(fs.promises, { path: png, named, maxBytes: 4 })).toEqual({ ok: false, reason: 'size' })
  })
  it('knows png, jpg, jpeg, gif, webp (any case)', () => {
    expect(Object.keys(PICTURE_TYPES).sort()).toEqual(['.gif', '.jpeg', '.jpg', '.png', '.webp'])
  })
})
