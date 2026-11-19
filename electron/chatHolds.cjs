'use strict'

/**
 * chatHolds.cjs — the chat's held hooks (the answer buttons): a
 * registry of the requests Claude Code is waiting on, answered from the chat
 * once or handed back to the terminal. Pure: timers, ids and the log are
 * injected; nothing here reads a body, writes a file or touches a terminal.
 *
 * A hold is one HTTP request the endpoint (chatHooks.cjs) did not answer at
 * once: a `PermissionRequest`, or a `PreToolUse` for `AskUserQuestion`. Its
 * states:
 *
 *   waiting-bind  opened; the reader (the worker) has not said what it is yet
 *   open          bound to a terminal, a call key and what an answer needs
 *   answered      an accepted chat:answer: the answer's JSON, once     (final)
 *   released      "no decision" (200, empty body): the terminal decides (final)
 *   gone          the client closed the request: nothing is sent      (final)
 *
 * A final state never changes and never responds again. Every hold is
 * bounded: unbound for 2 s, open for 300 s, both below the hook entry's own
 * timeout (entryTimeoutS), so Claude Code never waits on the app past it.
 *
 * The answer bodies are built here and only here. "Always allow" adds the
 * rules the hook itself suggested, for this session only: the destination is
 * the literal "session", whatever the suggestion said (any other scope would
 * write a file of Claude Code's). Deny tells Claude and lets it try another
 * way (no interrupt).
 */

const crypto = require('crypto')
const { errWord } = require('./chatLog.cjs')

/** The one source of hold times, limits and the hook entries' timeouts */
const HOLD = Object.freeze({ permissionMs: 300_000, questionMs: 300_000, bindMs: 2_000, max: 16, entryMarginS: 30 })

/** The message Claude reads when the user denies from the chat (Decision 18: no interrupt) */
const DENY_MESSAGE = 'The user denied this request.'

/** A hook entry's own timeout (seconds) for a held route: the hold's time plus a margin, never typed twice */
function entryTimeoutS(kind, limits = HOLD) {
  const ms = kind === 'question' ? limits.questionMs : limits.permissionMs
  return Math.ceil(ms / 1000) + limits.entryMarginS
}

/**
 * A development build's shorter holds (SPAWN_CHAT_HOLD_S, for a trial's timeout item): 5–300 s, never
 * longer than HOLD; anything else is HOLD itself. The entries' timeouts stay HOLD's (longer still).
 */
function shortHolds(seconds) {
  const s = Number.parseInt(String(seconds ?? ''), 10)
  if (!Number.isFinite(s) || s < 5 || s > 300) return HOLD
  return Object.freeze({ ...HOLD, permissionMs: s * 1000, questionMs: s * 1000 })
}

const RULES_MAX = 4
const RULE_TEXT_MAX = 2000
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/** The rules as an answer may carry them: { toolName, ruleContent? } strings only, at most 4; anything else → null */
function cleanRules(rules) {
  if (!Array.isArray(rules) || !rules.length || rules.length > RULES_MAX) return null
  const out = []
  for (const r of rules) {
    if (!isObj(r) || typeof r.toolName !== 'string' || !r.toolName || r.toolName.length > RULE_TEXT_MAX) return null
    if (r.ruleContent !== undefined && (typeof r.ruleContent !== 'string' || r.ruleContent.length > RULE_TEXT_MAX)) return null
    out.push(r.ruleContent === undefined ? { toolName: r.toolName } : { toolName: r.toolName, ruleContent: r.ruleContent })
  }
  return out
}

/**
 * A PermissionRequest's answer. 'allow'; 'always' (allow, and the rules for this session only);
 * 'deny' (with DENY_MESSAGE, no interrupt). Null for anything else (never answered).
 */
function permissionBody(choice, rules) {
  let decision
  if (choice === 'allow') decision = { behavior: 'allow' }
  else if (choice === 'deny') decision = { behavior: 'deny', message: DENY_MESSAGE }
  else if (choice === 'always') {
    const r = cleanRules(rules)
    if (!r) return null
    decision = { behavior: 'allow', updatedPermissions: [{ type: 'addRules', rules: r, behavior: 'allow', destination: 'session' }] }
  } else return null
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })
}

/**
 * An AskUserQuestion's answer through its held PreToolUse: the call's input as received, every field
 * of it kept (`updatedInput` replaces the input whole), with the chosen label as its
 * answer. `input` is the tool input (or, as before, its questions array alone).
 */
function questionBody(input, label) {
  const whole = Array.isArray(input) ? { questions: input } : input
  if (!isObj(whole)) return null
  const questions = whole.questions
  const q = Array.isArray(questions) && questions.length === 1 && isObj(questions[0]) ? questions[0] : null
  if (!q || typeof q.question !== 'string' || typeof label !== 'string') return null
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...whole, answers: { [q.question]: label } } } })
}

/** How the picked labels of a multi-select question are written in its answer (as Claude Code's own dialog joins them) */
const MULTI_JOIN = ', '

/**
 * Several questions at once, or a multi-select one: `picked` holds each question's chosen labels, in
 * the questions' order; the answer maps each question's text to its label, a multi-select's labels joined. The whole
 * input is kept. Verified shape: several questions (the record's `answers`, one entry per question);
 * the join of a multi-select is Claude Code's own dialog's, not yet seen in a record here.
 */
function questionsBody(input, picked) {
  if (!isObj(input) || !Array.isArray(input.questions) || !Array.isArray(picked)) return null
  const qs = input.questions
  if (!qs.length || qs.length !== picked.length) return null
  const answers = {}
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i]
    const labels = picked[i]
    if (!isObj(q) || typeof q.question !== 'string' || !q.question || q.question in answers) return null
    if (!Array.isArray(labels) || !labels.length || !labels.every(l => typeof l === 'string' && l)) return null
    if (labels.length > 1 && q.multiSelect !== true) return null
    answers[q.question] = labels.join(MULTI_JOIN)
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input, answers } } })
}

/** The most a question's own answer may hold (the terminal's field has no limit; a chat answer is a sentence or two) */
const OTHER_MAX = 2000

/**
 * A question's own words (its "Other" row): null for none (absent, null, blank), the words trimmed, or false when
 * they cannot be an answer (not a string, too long, a control character other than a line break or a tab)
 */
function otherWords(v) {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return false
  const w = v.replace(/\r\n?/g, '\n').trim()
  if (!w) return null
  if (w.length > OTHER_MAX || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(w)) return false
  return w
}

const FINAL = new Set(['answered', 'released', 'gone'])

/**
 * @param {object} o
 * @param {{ setTimeout(f: () => void, ms: number): unknown, clearTimeout(t: unknown): void }} o.timers
 * @param {(e: { holdId: string, id: string | null, kind: string, state: string, why?: string, choice?: string }) => void} [o.onChange]
 */
function createHolds({ timers, log = () => {}, limits = HOLD, onChange = () => {}, newId = () => crypto.randomBytes(12).toString('hex') }) {
  const holds = new Map()  // holdId → hold (final ones leave the map at once)
  let closed = false

  const view = (h) => ({ holdId: h.holdId, kind: h.kind, id: h.id, urlId: h.urlId, state: h.state })

  function changed(h, why, choice) {
    try { onChange({ holdId: h.holdId, id: h.id ?? h.urlId, kind: h.kind, state: h.state, why, choice }) } catch (err) { log('error', `chat holds: a listener failed (${errWord(err)})`) }
  }

  /**
   * The one way a hold ends: its state, its timer gone, at most one response. An answer that could not
   * be written (the client went that instant: `respond` says false, or throws) is `gone`, never "sent".
   * Returns the state it ended in, or null when it had ended already.
   */
  function finish(h, state, body, why, choice) {
    if (h.done) return null
    h.done = true
    h.state = state
    if (h.timer !== null) { timers.clearTimeout(h.timer); h.timer = null }
    holds.delete(h.holdId)
    if (state !== 'gone') {
      let wrote = true
      try { wrote = h.respond(state === 'answered' ? body : null) !== false } catch (err) { wrote = false; log('error', `chat holds: a response failed (${errWord(err)})`) }
      if (!wrote && state === 'answered') { h.state = 'gone'; why = 'client'; choice = undefined }
    }
    changed(h, why, choice)
    return h.state
  }

  function arm(h, ms, why) {
    if (h.timer !== null) timers.clearTimeout(h.timer)
    h.timer = timers.setTimeout(() => { h.timer = null; finish(h, 'released', null, why) }, ms)
  }

  /**
   * A held request has arrived (its body read). `respond(body | null)` answers it: a JSON text, or
   * null for "no decision". Null when closed or full: the endpoint then answers at once.
   */
  function open(kind, respond, { id = null } = {}) {
    if (closed || (kind !== 'permission' && kind !== 'question') || typeof respond !== 'function') return null
    if (holds.size >= limits.max) return null
    const holdId = newId()
    const h = { holdId, kind, respond, urlId: typeof id === 'string' ? id : null, id: null, key: null, data: null, state: 'waiting-bind', timer: null, done: false }
    holds.set(holdId, h)
    arm(h, limits.bindMs, 'unbound')
    changed(h, 'opened')
    return holdId
  }

  /**
   * The reader says what a hold is: its terminal, its call key, what an answer needs. Refused (and
   * released) when the terminal is not the one the request's URL named, or the data does not fit.
   */
  function bind(holdId, { id, key, data } = {}) {
    const h = holds.get(holdId)
    if (!h || h.done || h.state !== 'waiting-bind') return false
    if (typeof id !== 'string' || !id || (h.urlId !== null && h.urlId !== id)) { finish(h, 'released', null, 'other-terminal'); return false }
    let d = null
    if (h.kind === 'permission') d = { rules: cleanRules(data?.rules) ?? [] }
    else {
      const okSet = (l) => Array.isArray(l) && l.length >= 2 && l.length <= 6 && l.every(x => typeof x === 'string')
      // (the call's whole input, when the reader sent it: the answer keeps every field of it)
      const input = isObj(data?.input) ? data.input : { questions: data?.questions }
      const qs = Array.isArray(input.questions) ? input.questions : null
      // each question's labels (several questions or a multi-select), else the one question's
      const sets = Array.isArray(data?.sets) ? data.sets : okSet(data?.labels) ? [data.labels] : null
      if (!qs || !sets || sets.length !== qs.length || sets.length < 1 || sets.length > 4 || !sets.every(okSet)) { finish(h, 'released', null, 'shape'); return false }
      d = { questions: qs, labels: [...sets[0]], sets: sets.map(l => [...l]), multi: qs.map(q => isObj(q) && q.multiSelect === true), input }
    }
    h.id = id
    h.key = typeof key === 'string' ? key : null
    h.data = d
    h.state = 'open'
    arm(h, h.kind === 'question' ? limits.questionMs : limits.permissionMs, 'timeout')
    changed(h, 'bound')
    return true
  }

  /** "No decision" now (the reader passed it, evidence, a key, hidden, off …): the terminal decides */
  function release(holdId, why = 'released') {
    const h = holds.get(holdId)
    return h ? finish(h, 'released', null, why) !== null : false
  }
  const pass = (holdId, why = 'passed') => release(holdId, why)

  function releaseWhere(pred, why) {
    let n = 0
    for (const h of [...holds.values()]) {
      let hit = false
      try { hit = pred(view(h)) === true } catch { hit = false }
      if (hit && finish(h, 'released', null, why) !== null) n++
    }
    return n
  }

  const releaseAll = (why) => releaseWhere(() => true, why)

  /** The client closed the request first: nothing can be sent any more */
  function gone(holdId) {
    const h = holds.get(holdId)
    if (h) finish(h, 'gone', null, 'client')
  }

  /**
   * An answer from the chat. Accepted only for an open hold of this terminal while its chat is the
   * visible view (and the window is), a choice that fits, and — for "always" — rules to add.
   */
  function answer(holdId, { id, choice, option, picks, other, visibleId, windowVisible } = {}) {
    const h = typeof holdId === 'string' ? holds.get(holdId) : undefined
    if (!h || h.done) return { ok: false, reason: 'gone' }
    if (h.state !== 'open') return { ok: false, reason: 'not-bound' }
    if (h.id !== id) return { ok: false, reason: 'other-session' }
    if (visibleId !== id || windowVisible !== true) return { ok: false, reason: 'hidden' }
    let body = null
    if (h.kind === 'permission') {
      if (choice !== 'allow' && choice !== 'always' && choice !== 'deny') return { ok: false, reason: 'invalid' }
      if (choice === 'always' && !h.data.rules.length) return { ok: false, reason: 'not-answerable' }
      body = permissionBody(choice, h.data.rules)
    } else if (choice === 'options') {
      // several questions or a multi-select: each question's picked options, by index — and each one's
      // own words, Claude Code's "Other" row (Type something): the words are that question's answer, after its picks
      // in a multi-select, alone in a single-select (as the terminal's dialog answers it)
      const { sets, multi } = h.data
      if (!Array.isArray(picks) || picks.length !== sets.length) return { ok: false, reason: 'invalid' }
      if (other !== undefined && (!Array.isArray(other) || other.length !== sets.length)) return { ok: false, reason: 'invalid' }
      const picked = []
      for (let i = 0; i < sets.length; i++) {
        const p = picks[i]
        const words = otherWords(other?.[i])
        if (words === false) return { ok: false, reason: 'invalid' }
        const n = (Array.isArray(p) ? p.length : 0) + (words === null ? 0 : 1)
        if (!Array.isArray(p) || !n || (n > 1 && !multi[i]) || new Set(p).size !== p.length) return { ok: false, reason: 'invalid' }
        if (!p.every(x => Number.isInteger(x) && x >= 0 && x < sets[i].length)) return { ok: false, reason: 'invalid' }
        const labels = [...p].sort((a, b) => a - b).map(x => sets[i][x])
        picked.push(words === null ? labels : [...labels, words])
      }
      body = questionsBody(h.data.input, picked)
    } else {
      // (one question, one choice: as before)
      if (choice !== 'option' || h.data.sets.length !== 1 || h.data.multi[0] || !Number.isInteger(option) || option < 0 || option >= h.data.labels.length) return { ok: false, reason: 'invalid' }
      body = questionBody(h.data.input, h.data.labels[option])
    }
    if (body === null) return { ok: false, reason: 'not-answerable' }
    // (the client went the very moment the answer was written: nothing reached Claude Code)
    if (finish(h, 'answered', body, 'answered', choice) !== 'answered') return { ok: false, reason: 'gone' }
    return { ok: true }
  }

  function get(holdId) { const h = holds.get(holdId); return h ? view(h) : null }

  /** The holds not ended of a terminal (bound to it, or named by its URL while not bound yet) */
  function openFor(id) { return [...holds.values()].filter(h => (h.id ?? h.urlId) === id).map(view) }

  /** Quitting: every hold answered "no decision", and no new one */
  function close(why = 'quit') { closed = true; return releaseAll(why) }

  /** Let holds be opened again (the chat turned on again after close) */
  function reopen() { closed = false }

  return { open, bind, pass, release, releaseWhere, releaseAll, gone, answer, get, openFor, close, reopen, size: () => holds.size }
}

module.exports = { questionsBody, otherWords, OTHER_MAX, MULTI_JOIN, HOLD, DENY_MESSAGE, entryTimeoutS, shortHolds, permissionBody, questionBody, cleanRules, createHolds, FINAL }
