/**
 * 1.10.14 bug: quitting and opening spawn again at once said "The spawn server did not start on port 3334".
 * The quit sent the server SIGTERM and let the single-instance lock go at once; the new run took the lock
 * while the old server still held the port. The quit now waits for the server to be gone (at most a few s).
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const h = require('../electron/helpers.cjs')

describe('waitForExit', () => {
  it('resolves once the child has exited, and its port is free by then', async () => {
    const port = 39_000 + Math.floor(Math.random() * 500)
    // a child that holds a port and takes 400 ms to let go of it after SIGTERM (as the server flushing)
    const child = spawn(process.execPath, ['-e', `
      const s = require('net').createServer().listen(${port}, '127.0.0.1', () => console.log('up'))
      process.on('SIGTERM', () => setTimeout(() => s.close(() => process.exit(0)), 400))
      setInterval(() => {}, 1000)
    `], { stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise<void>(r => child.stdout!.once('data', () => r()))
    child.kill('SIGTERM')
    const how = await h.waitForExit(child, 5000)
    expect(how).toBe('exited')
    await new Promise<void>((res, rej) => { const s = createServer().once('error', rej).listen(port, '127.0.0.1', () => s.close(() => res())) })
  })
  it('a child already gone resolves at once', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
    await new Promise(r => child.once('exit', r))
    expect(await h.waitForExit(child, 5000)).toBe('exited')
  })
  it('gives up after its time (the quit goes on; the watchdog has the last word)', async () => {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'])
    await new Promise(r => setTimeout(r, 300))
    const t0 = Date.now()
    expect(await h.waitForExit(child, 300)).toBe('timeout')
    expect(Date.now() - t0).toBeLessThan(1500)
    child.kill('SIGKILL')
  })
  it('no child (the server was not ours): resolves at once', async () => {
    expect(await h.waitForExit(null, 5000)).toBe('none')
  })
})

describe('startWithRetries (the new run, when the old server is still letting go of the port)', () => {
  const fakeChild = (exitAfter: number | null) => {
    const c: any = { exitCode: null, signalCode: null }
    if (exitAfter !== null) setTimeout(() => { c.exitCode = 1 }, exitAfter)
    return c
  }
  it('a server that lost the port (it exited) is started again after a pause; ready on the second try', async () => {
    const starts: number[] = []
    let n = 0
    const ok = await h.startWithRetries({
      start: () => { starts.push(Date.now()); return fakeChild(n++ === 0 ? 5 : null) },
      ready: async () => { await new Promise(r => setTimeout(r, 20)); return n > 1 },
      tries: 3, pause: 30,
    })
    expect(ok).toBe(true)
    expect(starts).toHaveLength(2)
  })
  it('a server still running but not ready is not started twice (no second server beside it)', async () => {
    let starts = 0
    const ok = await h.startWithRetries({ start: () => { starts++; return fakeChild(null) }, ready: async () => false, tries: 3, pause: 10 })
    expect(ok).toBe(false)
    expect(starts).toBe(1)
  })
  it('gives up after its tries', async () => {
    let starts = 0
    const ok = await h.startWithRetries({ start: () => { starts++; return fakeChild(0) }, ready: async () => { await new Promise(r => setTimeout(r, 5)); return false }, tries: 3, pause: 5 })
    expect(ok).toBe(false)
    expect(starts).toBe(3)
  })
})
