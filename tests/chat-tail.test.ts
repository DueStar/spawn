/**
 * electron/chatTail.cjs — one transcript file read for the chat lens: the end
 * first (bounded), new lines as they are appended, older pages on demand, and
 * a guard that notices when the file was rewritten instead of appended to.
 */

import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync, truncateSync, writeFileSync, writeSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FIX } from './chat-helpers'
import { budget } from './timing'

const require = createRequire(import.meta.url)
const { splitLines, createTail } = require('../electron/chatTail.cjs')
const { quickSkip } = require('../electron/chatSchema.cjs')

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-chat-tail-')); dirs.push(d); return d }
const keep = (t: string) => !quickSkip(t)

/** fs.promises with every byte read counted */
function countingFs() {
  const counter = { bytes: 0, reads: 0 }
  const fs = {
    ...fsp,
    async open(p: string, flags?: string) {
      const h = await fsp.open(p, flags)
      return new Proxy(h, {
        get(target, prop) {
          if (prop === 'read') {
            return async (...args: any[]) => {
              const r = await (target.read as any)(...args)
              counter.bytes += r.bytesRead
              counter.reads++
              return r
            }
          }
          const v = (target as any)[prop]
          return typeof v === 'function' ? v.bind(target) : v
        },
      })
    },
  }
  return { fs, counter }
}

describe('splitLines', () => {
  it('a line cut in the middle of a Korean character is put back together; offsets are bytes', () => {
    const full = Buffer.from('첫 줄\n두 번째 줄\n세 번째')
    const a = splitLines(full.subarray(0, 5), Buffer.alloc(0))
    expect(a.lines).toEqual([])
    expect(a.carry.length).toBe(5)
    const b = splitLines(full.subarray(5), a.carry)
    expect(b.lines).toEqual([{ text: '첫 줄', offset: 0 }, { text: '두 번째 줄', offset: 8 }])
    expect(b.carry.toString('utf8')).toBe('세 번째')
    // a base for where the carry starts in the file, and CRLF endings
    const c = splitLines(Buffer.from('x\r\ny\n'), Buffer.alloc(0), 100)
    expect(c.lines).toEqual([{ text: 'x', offset: 100 }, { text: 'y', offset: 103 }])
  })
})

describe('createTail', () => {
  it('readTail: the last lines in order with their offsets, reading only the end', async () => {
    const dir = tempDir()
    const file = join(dir, 's.jsonl')
    const lines = Array.from({ length: 300 }, (_, i) => `{"type":"user","n":${i}}`)
    writeFileSync(file, lines.join('\n') + '\n')
    const { fs, counter } = countingFs()
    const tail = createTail(file, { fs, chunk: 1024, guardBytes: 256 })
    const r = await tail.readTail({ want: 50, keep })
    expect(r.lines.map((l: any) => l.text)).toEqual(lines.slice(250))
    const raw = readFileSync(file)
    for (const l of r.lines) expect(raw.subarray(l.offset, l.offset + Buffer.byteLength(l.text)).toString()).toBe(l.text)
    expect(r.atStart).toBe(false)
    expect(r.endOffset).toBe(raw.length)
    expect(r.startOffset).toBe(r.lines[0].offset)
    expect(counter.bytes).toBeLessThanOrEqual(2 * 1024 + 2 * 256 + 64)
  })

  it('readNew: appended lines, a half line only once it is complete', async () => {
    const dir = tempDir()
    const file = join(dir, 's.jsonl')
    writeFileSync(file, '{"type":"user","n":0}\n')
    const tail = createTail(file, { guardBytes: 64 })
    expect((await tail.readTail({ want: 10, keep })).lines).toHaveLength(1)
    appendFileSync(file, '{"type":"user","n":1}\n{"type":"user","n":2}\n{"type":"user","n":3}\n{"type":"user","n":')
    const a = await tail.readNew({ keep })
    expect(a.rewritten).toBe(false)
    expect(a.lines.map((l: any) => JSON.parse(l.text).n)).toEqual([1, 2, 3])
    appendFileSync(file, '4}\n')
    const b = await tail.readNew({ keep })
    expect(b.lines.map((l: any) => JSON.parse(l.text).n)).toEqual([4])
    expect(b.lines[0].offset).toBe(readFileSync(file).indexOf('{"type":"user","n":4}'))
    expect((await tail.readNew({ keep })).lines).toEqual([])
    // bookkeeping appended is passed over
    appendFileSync(file, '{"type":"ai-title","aiTitle":"x"}\n{"type":"user","n":5}\n')
    expect((await tail.readNew({ keep })).lines.map((l: any) => JSON.parse(l.text).n)).toEqual([5])
  })

  it('notices a file cut short or rewritten in place', async () => {
    const dir = tempDir()
    const file = join(dir, 's.jsonl')
    const body = Array.from({ length: 20 }, (_, i) => `{"type":"user","n":${i}}`).join('\n') + '\n'
    writeFileSync(file, body)
    const t1 = createTail(file, { guardBytes: 64 })
    await t1.readTail({ want: 5, keep })
    truncateSync(file, 30)
    expect((await t1.readNew({ keep })).rewritten).toBe(true)

    writeFileSync(file, body)
    const t2 = createTail(file, { guardBytes: 64 })
    await t2.readTail({ want: 5, keep })
    const fd = openSync(file, 'r+')
    writeSync(fd, Buffer.from('{"type":"user","n":9'), 0, 20, 0) // same length, other bytes
    closeSync(fd)
    // nothing new to show yet: no read at all; the guard speaks at the next growth
    expect((await t2.readNew({ keep })).lines).toEqual([])
    appendFileSync(file, '{"type":"user","n":20}\n')
    expect((await t2.readNew({ keep })).rewritten).toBe(true)

    writeFileSync(file, body)
    const t3 = createTail(file, { guardBytes: 64 })
    await t3.readTail({ want: 5, keep })
    const at = body.length - 10
    const fd3 = openSync(file, 'r+')
    writeSync(fd3, Buffer.from('7'), 0, 1, at) // a byte changed near the end (the edge)
    closeSync(fd3)
    appendFileSync(file, '{"type":"user","n":99}\n')
    expect((await t3.readNew({ keep })).rewritten).toBe(true)
  })

  it('readNew with nothing new opens nothing and hashes nothing (review M11)', async () => {
    const dir = tempDir()
    const file = join(dir, 's.jsonl')
    writeFileSync(file, '{"type":"user","n":0}\n')
    const { fs, counter } = countingFs()
    let opens = 0
    const tail = createTail(file, { fs: { ...fs, open: (p: string, f?: string) => { opens++; return fs.open(p, f) } } })
    await tail.readTail({ want: 5, keep })
    const o = opens
    const b = counter.bytes
    for (let i = 0; i < 5; i++) expect((await tail.readNew({ keep })).lines).toEqual([])
    expect(opens).toBe(o)
    expect(counter.bytes).toBe(b)
    appendFileSync(file, '{"type":"user","n":1}\n')
    expect((await tail.readNew({ keep })).lines).toHaveLength(1)
  })

  it('readOlder walks back to the start; no line comes twice', async () => {
    const dir = tempDir()
    const file = join(dir, 's.jsonl')
    const lines = Array.from({ length: 120 }, (_, i) => (i % 3 === 0 ? `{"type":"mode","mode":"normal","i":${i}}` : `{"type":"user","n":${i}}`))
    writeFileSync(file, lines.join('\n') + '\n')
    const tail = createTail(file, { chunk: 256, guardBytes: 64 })
    const seen: string[] = []
    const first = await tail.readTail({ want: 10, keep })
    seen.push(...first.lines.map((l: any) => l.text))
    let atStart = first.atStart
    let pages = 0
    while (!atStart) {
      const r = await tail.readOlder({ want: 10, keep })
      expect(r.lines.length).toBeLessThanOrEqual(10 + 1)
      seen.unshift(...r.lines.map((l: any) => l.text))
      atStart = r.atStart
      if (++pages > 50) throw new Error('never reached the start')
    }
    expect(seen).toEqual(lines.filter(l => !l.includes('"mode"')))
    expect(new Set(seen).size).toBe(seen.length)
    expect(tail.state().startOffset).toBe(0)
    expect((await tail.readOlder({ want: 10, keep })).lines).toEqual([])
  })

  it('performance: the end of a 64 MB transcript is read alone, and the process never stalls', async () => {
    const dir = tempDir()
    const file = join(dir, 'big.jsonl')
    const block = readFileSync(join(FIX, 'tools.jsonl'), 'utf8')
    const noise = `{"parentUuid":null,"isSidechain":false,"attachment":{"type":"skill_listing","content":"${'s'.repeat(1 << 20)}"},"type":"attachment","uuid":"x","timestamp":"2026-11-13T00:00:00Z"}\n`
    const fd = openSync(file, 'w')
    let size = 0
    while (size < 64 * 1024 * 1024) { size += writeSync(fd, block); size += writeSync(fd, noise) }
    closeSync(fd)

    const { fs, counter } = countingFs()
    const tail = createTail(file, { fs })
    let last = Date.now()
    let worst = 0
    const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now }, 5)
    const r = await tail.readTail({ want: 150, keep })
    clearInterval(timer)
    worst = Math.max(worst, Date.now() - last)
    expect(r.lines.length).toBeGreaterThanOrEqual(150)
    expect(r.lines.every((l: any) => keep(l.text))).toBe(true)
    expect(counter.bytes).toBeLessThanOrEqual(16 * 1024 * 1024)
    // a wall-clock number: ×4 on a CI runner (tests/timing.ts; the macos-15-intel runner's worst was 107–130 ms)
    expect(worst).toBeLessThan(budget(100))
    rmSync(file)
  }, 60_000)
})
