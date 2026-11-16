/**
 * electron/chatImages.cjs — images pasted into the chat composer: told by their bytes (PNG,
 * JPEG, GIF, WebP and nothing else), capped, written by main under the app's own temp folder
 * with a name it makes (`<os temp>/spawn-chat-<instance>/<terminal id>/<24 hex>.<ext>`),
 * reachable only by the token it handed out, gone with the session, a removed chip and every
 * start. Real files in a temp folder.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { sniffImage, IMAGE_CAPS, imageRoot, createImageStore } = require('../electron/chatImages.cjs')

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-img-test-')); dirs.push(d); return d }

const T1 = '11111111-1111-4111-8111-111111111111'
const T2 = '22222222-2222-4222-8222-222222222222'
const bytes = (...b: number[]) => new Uint8Array(b)
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00)
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00)
const GIF = new Uint8Array(Buffer.from('GIF89a\x01\x00', 'latin1'))
const WEBP = new Uint8Array(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'))

describe('sniffImage', () => {
  it('by the magic bytes only', () => {
    expect(sniffImage(PNG)).toBe('png')
    expect(sniffImage(JPEG)).toBe('jpeg')
    expect(sniffImage(GIF)).toBe('gif')
    expect(sniffImage(new Uint8Array(Buffer.from('GIF87a..', 'latin1')))).toBe('gif')
    expect(sniffImage(WEBP)).toBe('webp')
    // not an image (or not one Claude Code sends to the model)
    expect(sniffImage(new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')))).toBeNull()
    expect(sniffImage(new Uint8Array(Buffer.from('GIF87b..', 'latin1')))).toBeNull()
    expect(sniffImage(new Uint8Array(Buffer.from('MZ\x90\x00\x03\x00', 'latin1')))).toBeNull()
    expect(sniffImage(new Uint8Array(Buffer.from('<!doctype html><html>')))).toBeNull()
    expect(sniffImage(new Uint8Array(Buffer.from('BM6\x00\x00\x00', 'latin1')))).toBeNull()
    expect(sniffImage(new Uint8Array(Buffer.from('RIFF\x10\x00\x00\x00WAVEfmt ', 'latin1')))).toBeNull()
    expect(sniffImage(bytes(0x89, 0x50, 0x4e))).toBeNull()
    expect(sniffImage(new Uint8Array(0))).toBeNull()
    expect(sniffImage('not bytes' as any)).toBeNull()
  })
  it('the caps', () => {
    expect(IMAGE_CAPS).toEqual({ bytes: 10 << 20, perSession: 64, sessionBytes: 256 << 20 })
  })
})

describe('the folder', () => {
  it('one per app instance, in the temp folder, named by a hash of the app\'s data folder', () => {
    const a = imageRoot('C:\\T', 'C:\\Users\\user\\AppData\\Roaming\\spawn')
    const b = imageRoot('C:\\T', 'C:\\Users\\user\\AppData\\Roaming\\spawn-dev')
    expect(a).toMatch(/^C:\\T[\\/]spawn-chat-[0-9a-f]{8}$/)
    expect(b).not.toBe(a)
    expect(imageRoot('C:\\T', 'C:\\Users\\user\\AppData\\Roaming\\spawn')).toBe(a)
  })
})

describe('the store', () => {
  it('saves under <root>/<terminal>/<24 hex>.<ext>, answers a token, and only that token finds the path', async () => {
    const root = join(tempDir(), 'spawn-chat-0a1b2c3d')
    const store = createImageStore({ root })
    const r = await store.save(T1, PNG)
    expect(r).toMatchObject({ ok: true, type: 'png' })
    expect(r.token).toMatch(/^[0-9a-f]{24}$/)
    const p = store.path(T1, r.token)
    expect(p).toBe(join(root, T1, `${r.token}.png`))
    expect(readFileSync(p)).toEqual(Buffer.from(PNG))
    // nothing else reaches a path: another terminal's token, a made-up token, a path
    expect(store.path(T2, r.token)).toBeNull()
    expect(store.path(T1, 'f'.repeat(24))).toBeNull()
    expect(store.path(T1, '../x')).toBeNull()
    expect(store.path(T1, `${r.token}.png`)).toBeNull()
    expect(store.path('../..', r.token)).toBeNull()
  })

  it('refuses: not an image, too big, too many for the session, a terminal id that is not a UUID', async () => {
    const store = createImageStore({ root: join(tempDir(), 'r') })
    expect(await store.save(T1, new Uint8Array(Buffer.from('<svg/>')))).toEqual({ ok: false, reason: 'type' })
    const big = new Uint8Array(IMAGE_CAPS.bytes + 1)
    big.set(PNG)
    expect(await store.save(T1, big)).toEqual({ ok: false, reason: 'size' })
    expect(await store.save('..\\evil', PNG)).toEqual({ ok: false, reason: 'off' })
    expect(await store.save(T1, 'x' as any)).toEqual({ ok: false, reason: 'type' })
    for (let i = 0; i < IMAGE_CAPS.perSession; i++) expect((await store.save(T2, PNG)).ok).toBe(true)
    expect(await store.save(T2, PNG)).toEqual({ ok: false, reason: 'limit' })
    // another session has its own count
    expect((await store.save(T1, JPEG)).ok).toBe(true)
  })

  it('the bytes per session are capped too', async () => {
    const store = createImageStore({ root: join(tempDir(), 'r'), caps: { bytes: 100, perSession: 64, sessionBytes: 250 } })
    const img = new Uint8Array(100)
    img.set(PNG)
    expect((await store.save(T1, img)).ok).toBe(true)
    expect((await store.save(T1, img)).ok).toBe(true)
    expect(await store.save(T1, img)).toEqual({ ok: false, reason: 'limit' })
  })

  it('a removed chip, a session that ends, the start: the files go', async () => {
    const root = join(tempDir(), 'spawn-chat-0a1b2c3d')
    const store = createImageStore({ root })
    const a = await store.save(T1, PNG)
    const b = await store.save(T1, GIF)
    await store.drop(T1, a.token)
    expect(existsSync(join(root, T1, `${a.token}.png`))).toBe(false)
    expect(store.path(T1, a.token)).toBeNull()
    expect(store.path(T1, b.token)).not.toBeNull()
    await store.dropSession(T1)
    expect(existsSync(join(root, T1))).toBe(false)
    expect(store.path(T1, b.token)).toBeNull()
    // an earlier run's leftovers
    mkdirSync(join(root, T2), { recursive: true })
    writeFileSync(join(root, T2, 'old.png'), 'x')
    await createImageStore({ root }).sweep()
    expect(existsSync(root)).toBe(false)
  })

  it('a token made by another store (an earlier run) is not known', async () => {
    const root = join(tempDir(), 'r')
    const first = await createImageStore({ root }).save(T1, PNG)
    expect(createImageStore({ root }).path(T1, first.token)).toBeNull()
  })

  it('the file is written new (never over another), and its name is never the page\'s', async () => {
    const root = join(tempDir(), 'r')
    let n = 0
    const store = createImageStore({ root, randomBytes: () => Buffer.alloc(12, n++ < 2 ? 7 : 9) })
    const a = await store.save(T1, PNG)
    expect(a.ok).toBe(true)
    // the same random name again: refused by the write ('wx'), then a fresh name
    const b = await store.save(T1, PNG)
    expect(b.ok).toBe(true)
    expect(b.token).not.toBe(a.token)
    expect(readdirSync(join(root, T1)).sort()).toEqual([`${a.token}.png`, `${b.token}.png`].sort())
  })
})

describe('source checks', () => {
  const read = (f: string) => readFileSync(join(__dirname, '..', 'electron', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
  it('no clipboard in the image store or the host', () => {
    for (const f of ['chatImages.cjs', 'chatHost.cjs']) expect(read(f), f).not.toMatch(/clipboard/i)
  })
  it('the store writes and removes only paths under its root', () => {
    const src = read('chatImages.cjs')
    const calls = [...src.matchAll(/fs\.(writeFile|open|rm|unlink|mkdir)\(([^,)]*)/g)]
    expect(calls.length).toBeGreaterThan(3)
    for (const m of calls) expect(m[2].trim(), m[0]).toMatch(/^(file|dir|root)$/)
    expect(src).toMatch(/const dir = path\.join\(root, terminalId\)/)
    expect(src).toMatch(/const file = path\.join\(dir, `\$\{token\}\.\$\{type === 'jpeg' \? 'jpg' : type\}`\)/)
  })
})
