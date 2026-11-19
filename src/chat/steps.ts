/**
 * Steps in the turn summary: how far the session's Pokémon walked during one turn,
 * shown only when it can be known exactly.
 *
 * The game server publishes steps without a broadcast, so the page's own game state would be stale. Two
 * reads of the server's existing, read-only GET /pokedex bracket a turn instead:
 *   - a start sample when the session goes to work (its status idle / starting → working);
 *   - an end sample 1.5 s after a turn end that arrived live (src/chat/store.ts onAppended: never one from a
 *     reset, a resync or an older page), taken only if the session is not working (or waiting) again then.
 * The turn's steps are end − start only when there is an unused start sample of the same session, the same
 * Pokémon (uid) at both reads, no other turn end or start of that session between, the end read not before
 * the start read, and no fewer steps at the end. The start sample is spent by the first turn end after it.
 * Anything else, a failed read included, gives nothing: no count is guessed.
 *
 * The request carries nothing of the user: no token, no header, no session text, no cookie (credentials
 * omitted). The ledger exists only for a chat view drawn outside 업무 모드 (stepLedgerFor(false) makes
 * nothing, so nothing is read); results live in memory (≤ 500 per session) and go with the session
 * (onChatForget).
 */

import { serverHttpBase } from '../serverUrl'
import { onChatForget } from './lensMode'
import type { LensStatus } from './types'

/** How long after a turn end its end sample is read (the steps the server is still adding settle) */
export const END_DELAY_MS = 1500
/** Results kept per session (the oldest go first) */
export const RESULTS_PER_SESSION = 500

export interface StepSample { at: number; uid: string; steps: number }

type Timers = { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void }
export interface StepLedgerDeps {
  /** GET /pokedex's body (the server's public game state) */
  fetchDex?: () => Promise<unknown>
  now?: () => number
  timers?: Timers
}

/** The session's Pokémon and its steps in a GET /pokedex body, or null when the body does not say them */
export function sampleOf(dex: unknown, sessionId: string, at: number): StepSample | null {
  if (!dex || typeof dex !== 'object') return null
  const { assign, mons } = dex as { assign?: unknown; mons?: unknown }
  if (!assign || typeof assign !== 'object' || !mons || typeof mons !== 'object') return null
  const uid = (assign as Record<string, unknown>)[sessionId]
  if (typeof uid !== 'string' || !uid) return null
  const mon = (mons as Record<string, unknown>)[uid]
  const steps = mon && typeof mon === 'object' ? (mon as { steps?: unknown }).steps : undefined
  if (typeof steps !== 'number' || !Number.isFinite(steps) || steps < 0) return null
  return { at, uid, steps }
}

/** The one read: the server's public game state, with nothing of the user in the request */
const readDex = (): Promise<unknown> =>
  fetch(`${serverHttpBase()}/pokedex`, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' }).then(r => (r.ok ? r.json() : Promise.reject(new Error('status'))))

type Start = { state: 'pending' | 'ready' | 'spent'; sample: StepSample | null }
interface Session {
  /** the latest start sample (a newer start replaces it) */
  start: Start | null
  /** bumped by every start and turn end: an end read made before the bump is void */
  gen: number
  timer: unknown
  results: Map<string, number>
}

export interface StepLedger {
  onWorking(sessionId: string): void
  onTurnEnd(sessionId: string, turnEndId: string, statusAfter: () => LensStatus['state'] | null | undefined): void
  /** The steps of a turn (by its turn-end item's id), or null when they are not known */
  stepsFor(turnEndId: string): number | null
  subscribe(fn: () => void): () => void
  /** Results kept for a session (a test's look) */
  size(sessionId: string): number
  /** The view stopped watching the session: samples and a pending read dropped (what is known stays) */
  stop(sessionId: string): void
  /** The session is gone: everything of it dropped */
  forget(sessionId: string): void
}

export function createStepLedger({ fetchDex = readDex, now = Date.now, timers }: StepLedgerDeps = {}): StepLedger {
  const clock: Timers = timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>) }
  const sessions = new Map<string, Session>()
  const subs = new Set<() => void>()
  const of = (sid: string): Session => {
    let s = sessions.get(sid)
    if (!s) { s = { start: null, gen: 0, timer: null, results: new Map() }; sessions.set(sid, s) }
    return s
  }
  const read = (): Promise<unknown> => { try { return Promise.resolve(fetchDex()) } catch (err) { return Promise.reject(err) } }
  const cancel = (s: Session) => { if (s.timer !== null) { clock.clearTimeout(s.timer); s.timer = null } }

  function record(sid: string, turnEndId: string, steps: number) {
    const s = sessions.get(sid)
    if (!s) return
    s.results.delete(turnEndId)
    s.results.set(turnEndId, steps)
    while (s.results.size > RESULTS_PER_SESSION) s.results.delete(s.results.keys().next().value as string)
    subs.forEach(fn => fn())
  }

  return {
    onWorking(sid) {
      const s = of(sid)
      s.gen++
      cancel(s)
      const start: Start = { state: 'pending', sample: null }
      s.start = start
      const at = now()
      read().then(body => {
        if (start.state !== 'pending') return
        start.sample = sampleOf(body, sid, at)
        start.state = start.sample ? 'ready' : 'spent'
      }, () => { if (start.state === 'pending') start.state = 'spent' })
    },

    onTurnEnd(sid, turnEndId, statusAfter) {
      const s = of(sid)
      s.gen++
      cancel(s)
      const start = s.start
      // the first turn end after a start spends it (a second turn under the same start is never counted)
      const usable = start?.state === 'ready' ? start.sample : null
      if (start) start.state = 'spent'
      if (!usable) return
      const gen = s.gen
      s.timer = clock.setTimeout(() => {
        s.timer = null
        if (s.gen !== gen || sessions.get(sid) !== s) return
        const state = statusAfter()
        if (state === 'working' || state === 'waiting') return
        const at = now()
        read().then(body => {
          if (s.gen !== gen || sessions.get(sid) !== s) return
          const end = sampleOf(body, sid, at)
          if (!end || end.uid !== usable.uid || end.at < usable.at || end.steps < usable.steps) return
          record(sid, turnEndId, end.steps - usable.steps)
        }, () => {})
      }, END_DELAY_MS)
    },

    stepsFor(turnEndId) {
      for (const s of sessions.values()) {
        const n = s.results.get(turnEndId)
        if (n !== undefined) return n
      }
      return null
    },

    subscribe(fn) {
      subs.add(fn)
      return () => { subs.delete(fn) }
    },

    size: sid => sessions.get(sid)?.results.size ?? 0,

    stop(sid) {
      const s = sessions.get(sid)
      if (!s) return
      s.gen++
      cancel(s)
      if (s.start) s.start.state = 'spent'
      s.start = null
    },

    forget(sid) {
      const s = sessions.get(sid)
      if (!s) return
      cancel(s)
      if (s.start) s.start.state = 'spent'
      sessions.delete(sid)
      subs.forEach(fn => fn())
    },
  }
}

// ---- the page's one ledger (made by the first chat view drawn outside 업무 모드)

let ledger: StepLedger | null = null
/** Which session each terminal showed (onChatForget names terminals) */
const sessionOfTerminal = new Map<string, string>()

/** The page's ledger for a view that may count steps; none (and nothing made, nothing read) otherwise */
export function stepLedgerFor(game: boolean): StepLedger | null {
  if (!game) return null
  if (!ledger) ledger = createStepLedger()
  return ledger
}

/** A view of terminal `terminalId` watches session `sessionId` (what onChatForget lets go of later) */
export function noteStepSession(terminalId: string, sessionId: string): void {
  sessionOfTerminal.set(terminalId, sessionId)
}

onChatForget(id => {
  const sid = sessionOfTerminal.get(id)
  sessionOfTerminal.delete(id)
  if (sid && ledger) ledger.forget(sid)
})
