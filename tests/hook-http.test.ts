/**
 * The game's hooks as Claude Code http hooks: the server's POST
 * /hook/<key>/<terminal>/<Event> (server/index.js hookRoute) and the settings
 * file entries that reach it (electron/terminals.cjs gameHookEntries).
 *
 * The oracle is the command hook: the same payloads go through the old path
 * (hooks/spawn-hook.cjs run as a process, its signed POST to /event) on one
 * server and through the new route on another, and the two servers must end
 * every step in the same state.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listen, loadServer, removeServer, type Office } from './helpers'

const require = createRequire(import.meta.url)
const REPO = fileURLToPath(new URL('..', import.meta.url))
const HOOK = join(REPO, 'hooks', 'spawn-hook.cjs')
const { hookUrlKey, HOOK_EVENTS, HTTP_HOOK_EVENTS, COMMAND_ONLY_EVENTS, buildEvent } = require('../hooks/hook-event.cjs')
const { sessionSettingsJson, gameHookEntries, createTerminalManager } = require('../electron/terminals.cjs')
const { chatHookEntries } = require('../electron/chatHooks.cjs')

const TERMINAL = '11111111-2222-4333-8444-555555555555'
const CONVO = '8cf68f64-5433-40f7-a130-557fc7f67e42'
const KEY = 'ab'.repeat(16)
const RUNTIME = 'C:\\Program Files\\spawn\\spawn.exe'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'spawn-hookhttp-')); dirs.push(d); return d }

/** POST a body the way Claude Code's http hook does (its own socket, JSON, no auth header) */
function post(port: number, urlPath: string, body: string | Buffer, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, any>; ms: number }>((resolve, reject) => {
    const started = performance.now()
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
    const req = httpRequest({ host: '127.0.0.1', port, path: urlPath, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': String(buf.length), ...headers } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, headers: res.headers, ms: performance.now() - started }))
    })
    req.on('error', reject)
    req.end(buf)
  })
}

/** Run hooks/spawn-hook.cjs as a session's command hook would (payload on stdin, the terminal's env) */
function runScript(payload: unknown, env: Record<string, string>) {
  return new Promise<{ status: number | null; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env: { ...process.env, SPAWN_EVENT_URL: '', SPAWN_LINK_FILE: '', ...env } })
    let stdout = ''
    child.stdout.setEncoding('utf8').on('data', (c: string) => { stdout += c })
    child.on('exit', (status) => resolve({ status, stdout }))
    child.stdin.end(JSON.stringify(payload))
  })
}

/** A server state with the clock taken out: every millisecond time (and how long ago) dropped */
function timeless(value: any): any {
  if (Array.isArray(value)) return value.map(timeless)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => !(typeof v === 'number' && v > 1e12)).map(([k, v]) => [k, timeless(v)]))
  }
  return value
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------

describe('the settings file with the game\'s http hooks', () => {
  const GAME = { port: 3334, key: KEY, id: TERMINAL }

  it('every event but SessionStart is an http hook to /hook/<key>/<terminal>/<Event>, 3 s, no async', () => {
    expect(COMMAND_ONLY_EVENTS).toEqual(['SessionStart'])
    expect(HTTP_HOOK_EVENTS).toEqual(HOOK_EVENTS.filter((e: string) => e !== 'SessionStart'))
    const s = JSON.parse(sessionSettingsJson(REPO, RUNTIME, null, GAME))
    expect(Object.keys(s.hooks)).toEqual(HOOK_EVENTS)
    for (const e of HTTP_HOOK_EVENTS) {
      expect(s.hooks[e], e).toEqual([{ hooks: [{ type: 'http', url: `http://127.0.0.1:3334/hook/${KEY}/${TERMINAL}/${e}`, timeout: 3 }] }])
    }
    // SessionStart: the command hook as in 1.4.0 (it also writes the session-links file), waited for
    const plain = JSON.parse(sessionSettingsJson(REPO, RUNTIME))
    expect(s.hooks.SessionStart).toEqual(plain.hooks.SessionStart)
    expect(s.hooks.SessionStart[0].hooks[0]).not.toHaveProperty('async')
    // the status line stays a command (Claude Code runs only a command there)
    expect(s.statusLine).toEqual(plain.statusLine)
    // the token never: only the key, and no headers / env interpolation
    expect(JSON.stringify(s)).not.toMatch(/headers|allowedEnvVars/)
  })

  it('without game (no token known): release 1.4.0 text, byte for byte', () => {
    expect(sessionSettingsJson(REPO, RUNTIME, null, null)).toBe(sessionSettingsJson(REPO, RUNTIME))
    expect(sessionSettingsJson(REPO, RUNTIME)).toContain('"async": true')
  })

  it('with the chat hooks as well: the game\'s group first, the chat\'s after it', () => {
    const CHAT = chatHookEntries({ port: 51234, token: 'cd'.repeat(24), id: TERMINAL })
    const s = JSON.parse(sessionSettingsJson(REPO, RUNTIME, CHAT, GAME))
    const game = gameHookEntries(GAME)
    expect(s.hooks.Stop).toEqual([game.Stop, CHAT.Stop])
    expect(s.hooks.MessageDisplay).toEqual([CHAT.MessageDisplay])
    expect(s.hooks.SessionStart).toHaveLength(1)
    expect(s.hooks.SessionStart[0].hooks[0].type).toBe('command')
  })

  it('refuses entries that would not reach the route (no terminal id, a bad port or key)', () => {
    expect(() => gameHookEntries({ ...GAME, id: 'x' })).toThrow()
    expect(() => gameHookEntries({ ...GAME, port: 0 })).toThrow()
    expect(() => gameHookEntries({ ...GAME, key: 'not-a-key' })).toThrow()
  })
})

describe('the terminal manager and the game\'s http hooks', () => {
  function fakePty() {
    const spawned: { args: string[] }[] = []
    let pid = 100
    return {
      spawned,
      spawn(_c: string, args: string[]) {
        spawned.push({ args })
        return { pid: pid++, onData() {}, onExit() {}, kill() {}, write() {}, resize() {} }
      },
    }
  }
  const launchedWith = (pty: ReturnType<typeof fakePty>) => { const a = pty.spawned.at(-1)!.args; return a[a.indexOf('--settings') + 1] }
  const make = (gameHooks: () => any) => {
    const pty = fakePty()
    const userDataDir = tempDir()
    const terms = createTerminalManager({ repoRoot: REPO, userDataDir, defaultCwd: userDataDir, send: () => {}, pty, killTree: () => {}, gameHooks })
    return { pty, terms, userDataDir }
  }

  it('a token known: each Claude Code session gets a file of its own naming its terminal', () => {
    const { pty, terms, userDataDir } = make(() => ({ port: 4321, key: KEY }))
    const a = terms.create({})
    const fa = launchedWith(pty)
    const b = terms.create({})
    const fb = launchedWith(pty)
    expect(path.basename(fa)).toMatch(/^session-settings-game-[0-9a-f]{12}\.json$/)
    expect(fa).not.toBe(fb)
    expect(path.dirname(fa)).toBe(userDataDir)
    expect(readFileSync(fa, 'utf8')).toBe(sessionSettingsJson(REPO, process.execPath, null, { port: 4321, key: KEY, id: a.id }))
    expect(readFileSync(fb, 'utf8')).toContain(`/hook/${KEY}/${b.id}/Stop`)
    // not armed for the chat (no chat hooks in it)
    expect('chat' in a).toBe(false)
    // its file goes with the tab
    terms.close(a.id)
    expect(existsSync(fa)).toBe(false)
    expect(existsSync(fb)).toBe(true)
  })

  it('no token yet, or a broken one: the 1.4.0 file (command hooks), the session still opens', () => {
    for (const gameHooks of [() => null, () => { throw new Error('x') }, () => ({ port: 4321, key: 'nope' })]) {
      const { pty, terms, userDataDir } = make(gameHooks)
      terms.create({})
      expect(launchedWith(pty)).toBe(join(userDataDir, 'session-settings.json'))
      expect(readFileSync(launchedWith(pty), 'utf8')).toBe(sessionSettingsJson(REPO, process.execPath))
    }
  })

  it('a shell tab gets no settings file at all', () => {
    const { pty, terms } = make(() => ({ port: 4321, key: KEY }))
    terms.create({ tool: 'shell' })
    expect(pty.spawned.at(-1)!.args).not.toContain('--settings')
  })
})

// ---------------------------------------------------------------------------

describe('POST /hook: the route', () => {
  let office: Office
  let port = 0
  let key = ''
  beforeAll(async () => {
    office = await loadServer()
    port = await listen(office.server.httpServer)
    key = hookUrlKey(office.server.AUTH_TOKEN)
  })
  afterAll(() => { office.server.httpServer.close(); removeServer(office) })

  const url = (event: string, k = key, id = TERMINAL) => `/hook/${k}/${id}/${event}`
  const prompt = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ session_id: CONVO, cwd: '/home/me/proj', transcript_path: '/t/x.jsonl', hook_event_name: 'UserPromptSubmit', prompt: text, ...extra })

  it('answers an empty 200 (no decision, nothing added) and applies the event under the terminal\'s id', async () => {
    const res = await post(port, url('UserPromptSubmit'), prompt('fix the bug ✨'))
    expect(res.status).toBe(200)
    expect(res.body).toBe('')
    expect(res.headers['content-length']).toBe('0')
    const s = office.server.sessions.get(TERMINAL)
    expect(s?.main?.lastPrompt).toBe('fix the bug ✨')
    expect(office.server.sessions.has(CONVO)).toBe(false)
  })

  it('PermissionRequest: an empty 200 too (the dialog stays Claude Code\'s), and the hand goes up', async () => {
    const res = await post(port, url('PermissionRequest'), JSON.stringify({ session_id: CONVO, cwd: '/home/me/proj', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }))
    expect(res.status).toBe(200)
    expect(res.body).toBe('')
    await sleep(400) // the needs-you debounce
    expect(office.server.sessions.get(TERMINAL)?.main?.state).toBe('needs-you')
  })

  it('refuses a wrong key, a bad terminal id, an unknown or command-only event, an Origin, another Host', async () => {
    const body = prompt('x')
    expect((await post(port, url('UserPromptSubmit', 'cd'.repeat(16)), body)).status).toBe(404)
    expect((await post(port, url('UserPromptSubmit', office.server.AUTH_TOKEN), body)).status).toBe(404) // the token itself is not the key
    expect((await post(port, url('UserPromptSubmit', key, 'not-a-uuid'), body)).status).toBe(404)
    expect((await post(port, url('MessageDisplay'), body)).status).toBe(404)
    expect((await post(port, url('SessionStart'), body)).status).toBe(404)
    expect((await post(port, url('UserPromptSubmit'), body, { origin: 'http://127.0.0.1:3333' })).status).toBe(403)
    expect((await post(port, url('UserPromptSubmit'), body, { host: 'evil.example:80' })).status).toBe(421)
    // GET is not a hook
    expect((await request(office.server.app).get(url('Stop'))).status).toBe(404)
  })

  it('not JSON, or an event the game ignores: an empty 200, nothing applied', async () => {
    const before = JSON.stringify(timeless([...office.server.sessions.values()]))
    expect((await post(port, url('Stop'), 'not json')).status).toBe(200)
    expect((await post(port, url('PreToolUse'), JSON.stringify({ hook_event_name: 'PreToolUse' }))).status).toBe(200)
    expect(JSON.stringify(timeless([...office.server.sessions.values()]))).toBe(before)
  })

  it('a big PostToolUse body (a 3 MB tool response) is read whole: the hand that call raised comes down', async () => {
    const input = { command: 'cat big.log' }
    await post(port, url('PermissionRequest'), JSON.stringify({ session_id: CONVO, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: input }))
    await sleep(400)
    expect(office.server.sessions.get(TERMINAL)?.main?.state).toBe('needs-you')
    const res = await post(port, url('PostToolUse'), JSON.stringify({ session_id: CONVO, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: input, tool_response: { stdout: 'x'.repeat(3_000_000) } }))
    expect(res.status).toBe(200)
    expect(office.server.sessions.get(TERMINAL)?.main?.state).not.toBe('needs-you')
  })

  it('/event (the command hook of an older release\'s sessions) still works', async () => {
    const res = await request(office.server.app).post('/event').set('Authorization', `Bearer ${office.server.AUTH_TOKEN}`)
      .send({ type: 'session_prompt', sessionId: TERMINAL, text: 'still here', isWakeup: false })
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------

/**
 * One session's life, every event the game listens to: the command hook's path
 * on one server, the http route on another; after every step the two servers
 * hold the same sessions (clock aside). SessionStart goes through the command
 * hook on both, as it does in a real session.
 */
describe('POST /hook against the command hook (the oracle)', () => {
  const base = { session_id: CONVO, cwd: 'C:\\Users\\me\\work\\demo', transcript_path: `C:\\Users\\me\\.claude\\projects\\demo\\${CONVO}.jsonl`, prompt_id: 'd0f0818e-428e-4732-b3f2-6830d470b485' }
  const sub = { agent_id: 'a1921bf97b0af9fd1', agent_type: 'general-purpose' }
  const bash = { command: 'npm test', description: 'Run the tests' }
  const STEPS: Record<string, unknown>[] = [
    { ...base, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' },
    { ...base, hook_event_name: 'UserPromptSubmit', prompt: '버그 고쳐줘 ✨ and run the tests' },
    { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'C:\\Users\\me\\work\\demo\\src\\index.ts' }, tool_use_id: 'toolu_1' },
    { ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'C:\\Users\\me\\work\\demo\\src\\index.ts' }, tool_response: { file: { content: 'x'.repeat(5000) } }, tool_use_id: 'toolu_1' },
    { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: bash, tool_use_id: 'toolu_2' },
    { ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: bash, permission_suggestions: [] },
    { ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' },
    { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: bash, tool_response: { stdout: 'ok', stderr: '', interrupted: false }, tool_use_id: 'toolu_2' },
    { ...base, hook_event_name: 'PostToolBatch', tool_calls: [{}, {}] },
    { ...base, hook_event_name: 'PreToolUse', tool_name: 'mcp__github__search_issues', tool_input: { q: 'bug' } },
    { ...base, hook_event_name: 'PostToolUse', tool_name: 'mcp__github__search_issues', tool_input: { q: 'bug' }, tool_response: [{ type: 'text', text: '[]' }] },
    { ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'cat nope' }, error: 'Exit code 1\ncat: nope: No such file' },
    { ...base, ...sub, hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'TODO' } },
    { ...base, ...sub, hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: 'C:\\x\\a.ts', content: 'y' } },
    { ...base, ...sub, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'C:\\x\\a.ts', content: 'y' }, tool_response: {} },
    { ...base, ...sub, hook_event_name: 'SubagentStop', last_assistant_message: 'Found 3 TODOs.' },
    { ...base, hook_event_name: 'PreCompact', trigger: 'auto' },
    { ...base, hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'secret summary' },
    { ...base, hook_event_name: 'CwdChanged', old_cwd: base.cwd, new_cwd: 'C:\\Users\\me\\work\\other' },
    { ...base, hook_event_name: 'PostModelSwitch', from_model: 'claude-opus-5-5', to_model: 'claude-haiku-5-5', source: 'command' },
    { ...base, hook_event_name: 'Stop', last_assistant_message: 'Done: the tests pass.', background_tasks: [{ id: 'b1', type: 'local_bash', status: 'running', description: 'npm run watch' }], session_crons: [{}], stop_hook_active: false },
    { ...base, hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Watcher finished</summary>\n<result>lots</result>\n</task-notification>' },
    { ...base, hook_event_name: 'StopFailure', error: 'rate_limit', error_details: 'Too many requests' },
    { ...base, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' },
    { ...base, hook_event_name: 'SessionEnd', reason: 'clear' },
    { ...base, session_id: '99999999-8888-4777-8666-555555555555', hook_event_name: 'SessionStart', source: 'clear' },
    { ...base, session_id: '99999999-8888-4777-8666-555555555555', hook_event_name: 'UserPromptSubmit', prompt: 'after the clear' },
    { ...base, session_id: '99999999-8888-4777-8666-555555555555', hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' },
  ]

  let old: Office
  let neu: Office
  let oldPort = 0
  let neuPort = 0
  beforeAll(async () => {
    old = await loadServer()
    oldPort = await listen(old.server.httpServer)
    writeFileSync(join(old.dir, 'auth-token'), old.server.AUTH_TOKEN)
    neu = await loadServer()
    neuPort = await listen(neu.server.httpServer)
    writeFileSync(join(neu.dir, 'auth-token'), neu.server.AUTH_TOKEN)
  })
  afterAll(() => {
    old.server.httpServer.close(); neu.server.httpServer.close()
    removeServer(old); removeServer(neu)
  })

  const state = (o: Office) => timeless([...o.server.sessions.values()].map(s => JSON.parse(JSON.stringify(s))))

  it('every step leaves both servers with the same sessions', async () => {
    const neuKey = hookUrlKey(neu.server.AUTH_TOKEN)
    const env = (o: Office, p: number) => ({ SPAWN_HOME: o.dir, SPAWN_PORT: String(p), SPAWN_SESSION_ID: TERMINAL })
    let applied = 0
    for (const step of STEPS) {
      const event = String(step.hook_event_name)
      const was = await runScript(step, env(old, oldPort))
      expect(was.status).toBe(0)
      expect(was.stdout).toBe('')
      if (COMMAND_ONLY_EVENTS.includes(event)) {
        // a real session runs the command hook here, under either release
        await runScript(step, env(neu, neuPort))
      } else {
        const res = await post(neuPort, `/hook/${neuKey}/${TERMINAL}/${event}`, JSON.stringify(step))
        expect(res.status, event).toBe(200)
        expect(res.body, event).toBe('')
      }
      if (buildEvent(step, TERMINAL)) applied++
      if (event === 'PermissionRequest') await sleep(400) // let the needs-you debounce run out on both
      expect(state(neu), `after ${event}`).toEqual(state(old))
    }
    expect(applied).toBeGreaterThan(20)
    expect(old.server.sessions.get(TERMINAL)).toBeTruthy()
    expect(state(neu)).toEqual(state(old))
  }, 60_000)
})

/**
 * The order events reach the session in. Claude Code waits for each http
 * hook's answer before going on, and the route applies a body in the tick it
 * is read: the session follows the hooks in their order. The command hook's
 * tool-call hooks ran in the background and could arrive late.
 */
describe('POST /hook: order', () => {
  let office: Office
  let port = 0
  let key = ''
  beforeAll(async () => {
    office = await loadServer()
    port = await listen(office.server.httpServer)
    key = hookUrlKey(office.server.AUTH_TOKEN)
  })
  afterAll(() => { office.server.httpServer.close(); removeServer(office) })
  const send = (event: string, body: Record<string, unknown>) => post(port, `/hook/${key}/${TERMINAL}/${event}`, JSON.stringify({ session_id: CONVO, cwd: '/w/demo', hook_event_name: event, ...body }))

  it('a turn\'s hooks, one after the other: the session ends idle with the last prompt and reply', async () => {
    for (let i = 0; i < 30; i++) {
      await send('UserPromptSubmit', { prompt: `prompt ${i}` })
      await send('PreToolUse', { tool_name: 'Read', tool_input: { file_path: `/w/demo/f${i}.ts` } })
      await send('PostToolUse', { tool_name: 'Read', tool_input: { file_path: `/w/demo/f${i}.ts` }, tool_response: {} })
      await send('Stop', { last_assistant_message: `reply ${i}` })
    }
    const s = JSON.parse(JSON.stringify(office.server.sessions.get(TERMINAL)))
    expect(s.main.state).not.toBe('working')
    expect(s.main.lastPrompt).toBe('prompt 29')
    expect(s.main.lastReply).toBe('reply 29')
  })

  it('a tool call hook right before the turn\'s end never sets the session working again', async () => {
    await send('UserPromptSubmit', { prompt: 'go' })
    await send('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })
    await send('Stop', { last_assistant_message: 'done' })
    expect(office.server.sessions.get(TERMINAL)?.main?.state).not.toBe('working')
  })

  it('hooks sent at once (parallel tool calls) are each answered and each applied', async () => {
    await send('UserPromptSubmit', { prompt: 'parallel' })
    const calls = Array.from({ length: 20 }, (_, i) => send('PreToolUse', { tool_name: 'Grep', tool_input: { pattern: `p${i}` } }))
    const answers = await Promise.all(calls)
    expect(answers.every(a => a.status === 200 && a.body === '')).toBe(true)
    expect(office.server.sessions.get(TERMINAL)?.main?.state).toBe('working')
    await send('Stop', { last_assistant_message: 'all found' })
    expect(office.server.sessions.get(TERMINAL)?.main?.state).not.toBe('working')
  })
})
