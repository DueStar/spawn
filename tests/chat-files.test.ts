/**
 * electron/chatFiles.cjs — the composer's @ mention: file names from the session's own folder,
 * read by main (the folder comes from the terminal manager, never from the page). Names only:
 * no file is opened. Links and junctions are never followed, every folder's real path stays
 * inside the session's, the build and dependency folders are skipped, and the scan is capped
 * in entries and time. A real temporary tree.
 */

import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { listFiles, matchFiles, scan, SKIP_DIRS } = require('../electron/chatFiles.cjs')

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-files-')); dirs.push(d); return d }

function tree(files: string[]) {
  const root = tempDir()
  for (const f of files) {
    mkdirSync(join(root, ...f.split('/').slice(0, -1)), { recursive: true })
    writeFileSync(join(root, ...f.split('/')), 'x')
  }
  return root
}

describe('listFiles', () => {
  it('relative names with forward slashes; the build, dependency and dot folders skipped; a name with a space left out', async () => {
    const root = tree(['README.md', 'src/middleware.ts', 'src/lib/safe-redirect.ts', 'node_modules/x/index.js', '.git/HEAD', 'dist/app.js', '.cache/a', '.github/workflows/ci.yml', 'docs/my notes.md', 'build/out.txt', '__pycache__/a.pyc'])
    const files = await listFiles(root, '')
    expect(files.sort()).toEqual(['README.md', 'src/lib/safe-redirect.ts', 'src/middleware.ts'])
    for (const d of ['.git', 'node_modules', '.next', 'dist', 'build', 'out', 'target', '.venv', 'venv', '__pycache__', '.cache']) expect(SKIP_DIRS.has(d), d).toBe(true)
  })

  it('a junction or a link to a folder outside is never followed', async () => {
    const outside = tree(['secret.txt', 'deep/also-secret.txt'])
    const root = tree(['inside.ts'])
    let made = 0
    try { symlinkSync(outside, join(root, 'junction'), 'junction'); made++ } catch { /* this platform cannot make one */ }
    try { symlinkSync(outside, join(root, 'link'), 'dir'); made++ } catch { /* links need a privilege on Windows */ }
    try { symlinkSync(join(outside, 'secret.txt'), join(root, 'file-link.txt'), 'file'); made++ } catch { /* idem */ }
    const files = await listFiles(root, '')
    expect(files).toEqual(['inside.ts'])
    if (!made) console.warn('chat-files: no link could be made here; containment checked by realpath only')
    // (on Windows a junction needs no privilege: the case is real there)
    if (process.platform === 'win32') expect(made).toBeGreaterThan(0)
  })

  it('stops at maxScan entries and within its time budget', async () => {
    // 21 folders of 1,000 files each (21,021 entries), served by an injected fs: the walk is the real one, only the
    // disk is not (making 21,000 real files took ~34 s on Windows). What it proves is unchanged: the walk stops at
    // maxScan entries, keeps what it found, stays in its time, and a short budget stops it sooner.
    const root = join(tmpdir(), 'spawn-files-virtual-root')
    const dirent = (name: string, dir: boolean) => ({ name, isDirectory: () => dir, isFile: () => !dir, isSymbolicLink: () => false })
    const top = Array.from({ length: 21 }, (_, d) => dirent(`d${d}`, true))
    const leaves = Array.from({ length: 1000 }, (_, f) => dirent(`f${f}.ts`, false))
    let opened = 0
    const virtual = {
      realpath: async (p: string) => p,
      lstat: async () => ({ isSymbolicLink: () => false, isDirectory: () => true }),
      opendir: async (p: string) => {
        opened++
        const list = p === root ? top : leaves
        return { async *[Symbol.asyncIterator]() { for (const e of list) yield e }, close: async () => {} }
      },
    }
    const t0 = Date.now()
    const files = await listFiles(root, '', { fs: virtual, maxScan: 20_000, budgetMs: 2000, max: 1_000_000 })
    expect(files.length).toBeLessThanOrEqual(20_000)
    expect(files.length).toBeGreaterThan(1000)
    // it stopped inside the tree: not every one of the 21 folders was read to its end
    expect(files.length).toBeLessThan(21_000)
    expect(files[0]).toBe('d0/f0.ts')
    expect(opened).toBeLessThanOrEqual(22)
    expect(Date.now() - t0).toBeLessThan(4000)
    // a short budget stops sooner
    let clock = 0
    const few = await listFiles(root, '', { fs: virtual, now: () => (clock += 50), budgetMs: 400, max: 1_000_000 })
    expect(few.length).toBeLessThan(20)
  })

  it('names only: nothing is opened or read (source check)', () => {
    const src = readFileSync(join(__dirname, '..', 'electron', 'chatFiles.cjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
    expect(src).not.toMatch(/readFile|\bopen\(|createReadStream/)
    expect(src).toMatch(/isSymbolicLink\(\)/)
    expect(src).toMatch(/realpath/)
  })

  it('a folder that does not exist: nothing', async () => {
    expect(await listFiles(join(tempDir(), 'gone'), '')).toEqual([])
  })
})

describe('matchFiles', () => {
  const files = ['src/lib/safe-redirect.ts', 'src/middleware.ts', 'src/app/login/actions.ts', 'README.md', 'tests/safe-redirect.test.ts', 'src/redirect/index.ts']
  it('the query\'s letters in order, any case; a hit in the name first, then the shorter path', () => {
    expect(matchFiles(files, 'redir', 50)).toEqual(['src/lib/safe-redirect.ts', 'src/redirect/index.ts', 'tests/safe-redirect.test.ts'].sort((a, b) => {
      const order = ['src/lib/safe-redirect.ts', 'tests/safe-redirect.test.ts', 'src/redirect/index.ts']
      return order.indexOf(a) - order.indexOf(b)
    }))
    expect(matchFiles(files, 'MIDW', 50)).toEqual(['src/middleware.ts'])
    expect(matchFiles(files, 'zzz', 50)).toEqual([])
    expect(matchFiles(files, '', 2)).toEqual(['README.md', 'src/middleware.ts'])
  })
})

describe('the host: chat:files', () => {
  it('only for an armed Claude Code session, in its own folder from the terminal list (never one the page names)', async () => {
    const { createChatHost } = require('../electron/chatHost.cjs')
    const root = tree(['a.ts', 'b/c.ts'])
    const T1 = '11111111-1111-4111-8111-111111111111'
    const T2 = '22222222-2222-4222-8222-222222222222'
    const list = [{ id: T1, tool: 'claude', status: 'running', chat: 'armed', cwd: root }, { id: T2, tool: 'claude', status: 'running', chat: 'unarmed', cwd: root }]
    const host = createChatHost({
      terminals: { list: () => list, refreshSettings() {}, armedCount: () => 1 },
      send() {}, userDataDir: tmpdir(), claudeVersion: async () => '2.1.325',
      makeWorker: () => ({ on() {}, postMessage() {}, terminate() {} }),
      makeEndpoint: () => ({ listen: async () => ({ port: 1, token: 't' }), setDraining() {}, close: async () => {} }),
    })
    await host.enable()
    expect(await host.files({ id: T1, query: 'c' })).toEqual({ ok: true, files: ['b/c.ts'] })
    expect(await host.files({ id: T1, query: '', cwd: 'C:\\Windows' })).toEqual({ ok: true, files: ['a.ts', 'b/c.ts'] })
    expect(await host.files({ id: T2, query: '' })).toEqual({ ok: false })
    expect(await host.files({ id: 'nope', query: '' })).toEqual({ ok: false })
    host.disable()
    expect(await host.files({ id: T1, query: '' })).toEqual({ ok: false })
  })
})

void fs

describe('review fix: a slow folder (m13)', () => {
  it('a network share (\\\\server\\share, //server/share) is not walked: nothing is asked of the network', async () => {
    const asked: string[] = []
    const spy = { realpath: async (p: string) => { asked.push(p); return p }, lstat: async () => { throw new Error('x') }, opendir: async () => { throw new Error('x') } }
    expect(await scan('\\\\server\\share\\proj', { fs: spy })).toEqual([])
    expect(await scan('//server/share/proj', { fs: spy })).toEqual([])
    expect(asked).toEqual([])
  })

  it('a read that never answers: the walk ends within its budget with what it found', async () => {
    const root = tree(['a.ts', 'sub/b.ts'])
    const real = fs.promises
    const hang = { ...real, realpath: real.realpath, lstat: () => new Promise(() => {}), opendir: real.opendir }
    const t0 = Date.now()
    const out = await scan(root, { fs: hang, budgetMs: 150 })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(out).toEqual(['a.ts'])
  })
})
