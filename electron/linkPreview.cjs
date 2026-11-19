'use strict'

/**
 * linkPreview.cjs — the link-preview service the chat worker hosts: linkFetch.cjs previewOf (the policy and
 * the transport) behind a bounded memory cache, a small load limit and an on/off switch. It runs only in the chat
 * worker: never in the page, never in the main process's own thread.
 *
 *   Cache   memory only, nothing on disk: at most 200 cards, a card kept 24 h and a failure (null) 30 min; the images'
 *           bytes at most 16 MB in all, the least recently used card with an image going first. Emptied when previews
 *           go off; gone with the worker (the chat turned off, the app quitting).
 *   Load    at most 3 fetches at once and 1 per host; at most 24 waiting, the oldest waiting dropped (its caller hears
 *           null, nothing is fetched for it); the same URL asked while in flight or waiting shares that one fetch.
 *   Off     until setOn(true) nothing is fetched (get answers null). setOn(false) empties every cache, drops the
 *           queue and aborts every running fetch at once: its AbortSignal fires, so it makes
 *           no further request, redirect hop or image request and its sockets are destroyed; its callers hear null.
 *   Owners  a URL is asked for a view (`owner`, a terminal's id); release(owner) — the view closed — aborts the fetches
 *           and drops the waiting ones that no other view wants.
 *
 * Every failure is silent: null. This module logs nothing (linkFetch.cjs refusalLog, handed a writer by the worker,
 * says the kind of a refusal in fixed words).
 */

/** The one source of the service's limits (the plan's "Link preview policy": Load and Cache) */
const PREVIEW_CAPS = Object.freeze({
  cards: 200, okMs: 24 * 3600_000, failMs: 30 * 60_000,
  imageBytes: 16 << 20,
  running: 3, perHost: 1, queue: 24,
})

const hostOf = (url) => {
  try { return new URL(url).hostname.toLowerCase().replace(/\.$/, '') } catch { return '' }
}
const imageBytesOf = (card) => {
  const b = card && card.image && card.image.bytes
  return b && typeof b.byteLength === 'number' ? b.byteLength : 0
}

/**
 * @param {object} [o]
 * @param {(url: string, signal: AbortSignal) => Promise<object | null>} [o.fetchCard]  a URL → LinkCardData | null
 *   (linkFetch.cjs previewOf); it stops at once when `signal` aborts
 * @param {() => number} [o.now]
 * @param {Partial<typeof PREVIEW_CAPS>} [o.caps]
 */
function createPreviewService({ fetchCard, now = Date.now, caps } = {}) {
  // (a caller may lower a cap, never raise one)
  const C = caps && typeof caps === 'object'
    ? Object.freeze(Object.fromEntries(Object.entries(PREVIEW_CAPS).map(([k, v]) => [k, Number.isFinite(caps[k]) && caps[k] > 0 ? Math.min(caps[k], v) : v])))
    : PREVIEW_CAPS
  const fetchOne = typeof fetchCard === 'function' ? fetchCard : (url, signal) => require('./linkFetch.cjs').previewOf(url, { signal })

  let on = false
  let gen = 0                          // a fetch begun before previews last went off is not kept
  const cards = new Map()              // url → { card, until, bytes } (insertion order: least recently used first)
  let imageTotal = 0
  const jobs = new Map()               // url → its job, waiting or running (the same URL shares it)
  const queue = []                     // the jobs waiting, oldest first
  let running = 0
  const busy = new Map()               // host → fetches running for it
  const runningJobs = new Set()        // the jobs fetching now (aborted when previews go off)
  const NOBODY = ''                    // the owner of an ask that named no view (never released)

  const settle = (job, card) => { const w = job.waiters; job.waiters = []; for (const r of w) r(card) }

  function forget(url) {
    const e = cards.get(url)
    if (!e) return
    cards.delete(url)
    imageTotal -= e.bytes
  }

  function keep(url, card) {
    forget(url)
    const bytes = imageBytesOf(card)
    cards.set(url, { card, until: now() + (card ? C.okMs : C.failMs), bytes })
    imageTotal += bytes
    while (cards.size > C.cards) forget(cards.keys().next().value)
    // the images: the least recently used card holding one goes, until they fit
    while (imageTotal > C.imageBytes) {
      let victim = null
      for (const [u, e] of cards) if (e.bytes > 0) { victim = u; break }
      if (victim === null) break
      forget(victim)
    }
  }

  function start(job) {
    running++
    busy.set(job.host, (busy.get(job.host) ?? 0) + 1)
    runningJobs.add(job)
    Promise.resolve()
      .then(() => (job.ctrl.signal.aborted ? null : fetchOne(job.url, job.ctrl.signal)))
      .then((card) => (card && typeof card === 'object' ? card : null), () => null)
      .then((card) => {
        running--
        runningJobs.delete(job)
        const n = (busy.get(job.host) ?? 1) - 1
        if (n > 0) busy.set(job.host, n); else busy.delete(job.host)
        if (jobs.get(job.url) === job) jobs.delete(job.url)
        if (on && job.gen === gen && !job.ctrl.signal.aborted) { keep(job.url, card); settle(job, card) } else settle(job, null)
        pump()
      })
  }

  /** A running fetch stops now: no further request, hop or image; its sockets destroyed (linkFetch.cjs) */
  function abort(job) {
    try { job.ctrl.abort() } catch { /* (aborted already) */ }
  }

  /** Start what may start: at most C.running at once, C.perHost per host, oldest first */
  function pump() {
    for (let i = 0; i < queue.length && running < C.running;) {
      const job = queue[i]
      if ((busy.get(job.host) ?? 0) >= C.perHost) { i++; continue }
      queue.splice(i, 1)
      start(job)
    }
  }

  /**
   * The card for a URL, from memory or fetched (null: off, a failure, dropped from the queue, or stopped), asked for
   * the view `owner` (a terminal's id)
   */
  function get(url, owner) {
    if (!on || typeof url !== 'string' || !url) return Promise.resolve(null)
    const who = typeof owner === 'string' ? owner : NOBODY
    const hit = cards.get(url)
    if (hit) {
      if (now() < hit.until) {
        cards.delete(url)
        cards.set(url, hit)
        return Promise.resolve(hit.card)
      }
      forget(url)
    }
    const shared = jobs.get(url)
    if (shared) { shared.owners.add(who); return new Promise((resolve) => shared.waiters.push(resolve)) }
    const job = { url, host: hostOf(url), gen, waiters: [], owners: new Set([who]), ctrl: new AbortController() }
    const p = new Promise((resolve) => job.waiters.push(resolve))
    jobs.set(url, job)
    queue.push(job)
    while (queue.length > C.queue) {
      const old = queue.shift()
      jobs.delete(old.url)
      settle(old, null)
    }
    pump()
    return p
  }

  /** Every cache emptied (the switch stays) */
  function clear() {
    cards.clear()
    imageTotal = 0
  }

  /**
   * Previews on or off; off empties every cache, drops the queue and aborts every running fetch at once (each frees
   * its slot as soon as its transport is torn down; a new ask after previews come back starts afresh)
   */
  function setOn(v) {
    on = v === true
    if (on) return
    gen++
    clear()
    for (const job of queue) settle(job, null)
    queue.length = 0
    for (const job of [...runningJobs]) abort(job)
    jobs.clear()
  }

  /** View `owner` closed: what only it wanted stops (waiting: dropped, its callers hear null; running: aborted) */
  function release(owner) {
    if (typeof owner !== 'string' || owner === NOBODY) return
    for (const job of [...jobs.values()]) {
      if (!job.owners.delete(owner) || job.owners.size) continue
      jobs.delete(job.url)
      const i = queue.indexOf(job)
      if (i >= 0) { queue.splice(i, 1); settle(job, null) } else abort(job)
    }
  }

  function stats() { return { cards: cards.size, imageBytes: imageTotal, running, queued: queue.length, on } }

  return { get, setOn, clear, release, stats }
}

module.exports = { PREVIEW_CAPS, createPreviewService }
