/**
 * Shared helpers for the server tests.
 *
 * server/index.js keeps its state at module level (the sessions, the game,
 * ...). `loadServer()` re-evaluates the module with SPAWN_HOME pointed
 * at a fresh temp dir, so every call is a brand-new server that never touches
 * the real ~/.agent-office. Importing
 * the module does not bind port 3334 or write the auth token — only
 * `start()` does — so tests drive the Express app through supertest and
 * call `httpServer.listen(0)` themselves when they need a live socket.
 */

import { closeSync, mkdtempSync, openSync, rmSync, statfsSync, writeSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { vi } from 'vitest'

export type ServerModule = typeof import('../server/index.js')

export interface Office {
  /** Runtime dir this instance writes to (its SPAWN_HOME). */
  dir: string
  server: ServerModule
}

export interface LoadOptions {
  /** Reuse an existing runtime dir (simulates a server restart). */
  dir?: string
  /** Extra env vars that server/index.js reads at import time. */
  env?: Record<string, string>
}

/** Import a fresh copy of server/index.js against a temp runtime dir. */
export async function loadServer(opts: LoadOptions = {}): Promise<Office> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'spawn-test-'))
  process.env.SPAWN_HOME = dir
  // The registry roster (server/sessions.js) reads Claude Code's own
  // ~/.claude/sessions when started; a test office reads a (normally absent)
  // directory under its runtime dir instead, so the sessions of whoever runs
  // the suite never turn up in it. A test that wants a registry passes its own.
  const extra = Object.entries({
    SPAWN_REGISTRY_DIR: join(dir, 'registry'),
    ...(opts.env ?? {}),
  })
  for (const [key, value] of extra) process.env[key] = value
  try {
    vi.resetModules()
    const server = await import('../server/index.js')
    return { dir, server }
  } finally {
    for (const [key] of extra) delete process.env[key]
  }
}

/** Remove a temp runtime dir created by loadServer. */
export function removeServer(office: Office | undefined) {
  if (!office) return
  try { rmSync(office.dir, { recursive: true, force: true }) } catch {}
}

/**
 * POST a JSON body to a token-protected route (/event, /status, /pokedex/*,
 * ...) with the server's own bearer token, or a bad one.
 */
export function postAuthed(server: ServerModule, path: string, body: unknown, token: string = server.AUTH_TOKEN) {
  return request(server.app)
    .post(path)
    .set('Authorization', `Bearer ${token}`)
    .send(body as object)
}

/** POST /event with the server's own bearer token (or a bad one). */
export function postEvent(server: ServerModule, body: unknown, token: string = server.AUTH_TOKEN) {
  return postAuthed(server, '/event', body, token)
}

/**
 * The WebSocket subprotocols the app's page offers when it has the token
 * (src/officeToken.ts): `new WebSocket(url, serverProtocols(server))` is a
 * trusted connection, prompt / reply text included. A client that offers
 * none gets no conversation text (server/index.js, "The WebSocket").
 */
export function serverProtocols(server: ServerModule, token: string = server.AUTH_TOKEN): string[] {
  return [server.WS_PROTOCOL, `${server.WS_TOKEN_PROTOCOL_PREFIX}${token}`]
}

/** Bind an http.Server to an ephemeral localhost port and return the port. */
export function listen(httpServer: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject)
      resolve((httpServer.address() as AddressInfo).port)
    })
  })
}

/**
 * No Pokémon word, name, level or "HP" in 업무 모드: what a string shown in it must not
 * contain (tests/work-mode.test.ts and the chat view's tests; tests/visual/shots.mjs
 * keeps its own copy as GAME, being a plain script)
 */
export const GAME_WORDS = /포켓몬|몬스터볼|도감|박스|잡았|포획|파티|트레이너|Lv\.|\bHP\b|Pok[eé]|Poké|Pokédex|ポケモン|図鑑|ボックス|ゲット|トレーナー|モンスターボール/i

// ---- the chat view's long sessions (Phase 6, Task 6.1) --------------------------------------------------------------

/**
 * A long conversation as the page's store holds it: `count` items in turns (a prompt, a thinking block, reads that
 * group, an edit with its diff, a command with its output, a markdown answer with a link, the turn's end). Every
 * item has its own words ("river{n}") and the 300th from the end holds a word no other item has (`needle`).
 */
export function synthItems(count: number, { needle = 'quartzriver' }: { needle?: string } = {}): any[] {
  const T0 = Date.UTC(2026, 10, 14, 3, 0, 0)
  const items: any[] = []
  let n = 0
  const base = () => { n++; return { id: `s${n}`, order: n * 100, at: T0 + n * 1500 } }
  const diff = (k: number) => ({
    file: `src/river${k % 40}.js`, kind: 'edit', added: 2, removed: 1, hidden: 0,
    hunks: [{ oldStart: k + 1, newStart: k + 1, lines: [
      { t: ' ', old: k + 1, new: k + 1, text: `function river${k}(a, b) {` },
      { t: '-', old: k + 2, new: null, text: '  return a + b' },
      { t: '+', old: null, new: k + 2, text: `  return a + b // river ${k}` },
      { t: '+', old: null, new: k + 3, text: '  // the long way round' },
      { t: ' ', old: k + 3, new: k + 4, text: '}' },
    ] }],
  })
  for (let turn = 0; items.length < count; turn++) {
    const start = n
    items.push({ ...base(), kind: 'user', text: `Tidy river${turn} and tell me how long the Nile is.`, images: 0 })
    items.push({ ...base(), kind: 'thinking', text: '', durationMs: 3200 })
    for (let r = 0; r < 3; r++) items.push({ ...base(), kind: 'tool', tool: 'Read', input: { file: `src/river${(turn + r) % 40}.js` }, state: 'done', durationMs: 40 })
    items.push({ ...base(), kind: 'tool', tool: 'Edit', input: { file: `src/river${turn % 40}.js` }, state: 'done', diff: diff(turn), durationMs: 80 })
    items.push({ ...base(), kind: 'tool', tool: 'Bash', input: { command: `npm test -- river${turn}`, description: 'Run the river tests' }, state: 'done',
      output: { text: Array.from({ length: 12 }, (_, i) => `ok ${i + 1} river${turn} flows ${i * 7} km`).join('\n'), lines: 12, truncated: false, error: false }, durationMs: 900 })
    items.push({ ...base(), kind: 'text', text: `The **Nile** is about 6,650 km long (river${turn}).\n\n- the [Amazon](https://example.com/amazon-${turn}) carries more water\n- \`river${turn}\` now returns the sum\n\n\`\`\`js\nriver${turn}(1, 2)\n\`\`\`` })
    items.push({ ...base(), kind: 'turn-end', durationMs: (n - start) * 1500 })
  }
  items.length = count
  const at = Math.max(0, count - 300)
  for (let i = at; i < count; i++) if (items[i].kind === 'text') { items[i] = { ...items[i], text: `${items[i].text}\n\nOnly here: ${needle}.` }; break }
  return items
}

/** Free bytes on the disk that holds `dir` (null when the platform cannot say) */
export function freeBytes(dir: string): number | null {
  try { const s = statfsSync(dir); return s.bavail * s.bsize } catch { return null }
}

/**
 * A synthetic transcript of about `bytes` on disk, in the real lines' shapes (tests/fixtures/chat/changes.jsonl): turns
 * of a prompt, an answer, an Edit and its result with a structuredPatch, and every 50 edits a Write over a file whose
 * result carries a 1 MB `originalFile` (the multi-MB lines a long session has). Fresh uuids; never committed.
 * Returns the number of edits written.
 */
export function writeSynthTranscript(file: string, bytes: number, { cwd = 'C:\\Users\\user\\work\\demo', files = 40 }: { cwd?: string; files?: number } = {}): number {
  const fd = openSync(file, 'w')
  let n = 0
  let size = 0
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  const write = (o: unknown) => { const s = JSON.stringify(o) + '\n'; size += Buffer.byteLength(s); writeSync(fd, s) }
  const filler = 'The rivers flow on and the answer goes on with them. '.repeat(1500)
  const original = 'const river = "nile"\n'.repeat(Math.floor((1 << 20) / 21))
  const T0 = Date.parse('2026-11-14T05:00:00.000Z')
  write({ type: 'user', uuid: uuid(), timestamp: new Date(T0).toISOString(), message: { role: 'user', content: 'Tidy every river file.' } })
  let i = 0
  for (; size < bytes; i++) {
    const at = new Date(T0 + i * 1000).toISOString()
    write({ type: 'assistant', uuid: uuid(), timestamp: at, message: { role: 'assistant', id: `msg_big_${i}`, stop_reason: 'end_turn', content: [{ type: 'text', text: filler }] } })
    const id = `toolu_big_${i}`
    const fp = `${cwd}\\src\\river${i % files}.js`
    const write50 = i % 50 === 49
    write({ type: 'assistant', uuid: uuid(), timestamp: at, message: { role: 'assistant', id: `msg_bigt_${i}`, stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: write50 ? 'Write' : 'Edit', input: write50 ? { file_path: fp, content: 'b\n' } : { file_path: fp, old_string: 'a', new_string: 'b' } }] } })
    const result = write50
      ? { type: 'update', filePath: fp, content: 'b\n', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }], originalFile: original }
      : { filePath: fp, oldString: 'a', newString: 'b', structuredPatch: [{ oldStart: i + 1, oldLines: 1, newStart: i + 1, newLines: 1, lines: ['-a', '+b'] }], userModified: false, replaceAll: false }
    write({ type: 'user', uuid: uuid(), timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: result })
  }
  closeSync(fd)
  return i
}
