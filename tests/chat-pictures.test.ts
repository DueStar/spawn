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
const { readPicture, namedIn, PICTURE_TYPES, askedPath } = require('../electron/chatPictures.cjs')

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

describe('the boundary (review): nothing named loosely, nothing on the network, no links', () => {
  // Windows paths written with / and turned into backslashes (no escapes to get wrong)
  const B = String.fromCharCode(92)
  const w = (x: string) => x.split('/').join(B)
  it('namedIn matches whole paths, not a piece of a longer one', () => {
    expect(namedIn([{ text: `see ${w('C:/a/b.png.txt')} here` }], w('C:/a/b.png'))).toBe(false)
    expect(namedIn([{ text: `from ${w('D:/x/proj/img/a.png')}` }], w('/proj/img/a.png'))).toBe(false)
    expect(namedIn([{ text: `from ${w('D:/x/proj/img/a.png')}` }], w('img/a.png'))).toBe(false)
    expect(namedIn([{ text: `shot: \`${w('D:/x/a.png')}\`, done` }], w('D:/x/a.png'))).toBe(true)
    expect(namedIn([{ text: `${w('D:/x/a.png')}.` }], w('D:/x/a.png'))).toBe(true)
    expect(namedIn([{ files: [w('D:/x/a.png')] }], w('D:/x/a.png'))).toBe(true)
  })
  it('a network or device path is never touched (no stat: Windows would connect)', async () => {
    let touched = 0
    const spy = { stat: async () => { touched++; throw new Error('x') }, lstat: async () => { touched++; throw new Error('x') }, readFile: async () => { touched++; return Buffer.from('') } }
    for (const p of [w('//attacker/s/a.png'), '//attacker/s/a.png', w('//?/C:/a.png'), w('//./C:/a.png')]) {
      expect(await readPicture(spy, { path: p, named: () => true })).toEqual({ ok: false, reason: 'type' })
    }
    expect(touched).toBe(0)
  })
  it('a symbolic link is refused, even one named and ending in .png', async () => {
    const link = join(dir, 'link.png')
    try { fs.symlinkSync(txt, link) } catch { return } // (no right to make links here: nothing to check)
    expect(await readPicture(fs.promises, { path: link, named: () => true })).toEqual({ ok: false, reason: 'missing' })
  })
  it('askedPath: absolute stays; a relative one resolves in the folder, never with .., never on a network folder; drive-rooted refused on Windows', () => {
    expect(askedPath(w('C:/p/a.png'), w('C:/p'), 'win32')).toBe(w('C:/p/a.png'))
    expect(askedPath(w('img/a.png'), w('C:/p'), 'win32')).toBe(w('C:/p/img/a.png'))
    expect(askedPath(w('../../a.png'), w('C:/p'), 'win32')).toBeNull()
    expect(askedPath('img/../../a.png', w('C:/p'), 'win32')).toBeNull()
    expect(askedPath(w('img/a.png'), w('//srv/share'), 'win32')).toBeNull()
    expect(askedPath(w('/proj/a.png'), w('C:/p'), 'win32')).toBeNull()
    expect(askedPath('img/a.png', '', 'win32')).toBeNull()
  })
})
