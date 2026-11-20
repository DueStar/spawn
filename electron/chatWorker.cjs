'use strict'

/**
 * chatWorker.cjs — the worker thread the chat view reads in. All
 * transcript reading and parsing happens here (chatLens.cjs over real fs and
 * timers), so a session's multi-hundred-MB transcript can never block the
 * main process. Started and stopped by chatHost.cjs.
 *
 * main → worker: { t: 'init', claudeDir?, userDataDir, version }
 *                { t: 'terminals', list: [{ id, cwd, armed, status }] }
 *                { t: 'hook', event, raw, at, id?, hold? } (answered already — or held, with its hold id; the
 *                                                     body's bytes, capped, parsed here; id: the terminal its URL named)
 *                { t: 'hold-state', holdId, state, choice? }  (a held request ended: sent, timeout, terminal)
 *                { t: 'open' | 'close', id }
 *                { t: 'older' | 'reload' | 'resync', id, req? }  { t: 'agent', id, toolId, req? }
 *                { t: 'changes', id, req }  { t: 'change-file', id, file, before?, req }  (the change index)
 *                { t: 'preview', id, url, req }  { t: 'previews', on }  (link previews, only for a link
 *                                                     in an answer of terminal id's open view; `init` carries
 *                                                     preview: { allowLoopback, on }; off: every running fetch
 *                                                     aborted, every cache emptied; `close`: the fetches only that
 *                                                     view wanted aborted)
 * worker → main: { t: 'update', update: ChatUpdate }
 *                { t: 'prompt', id }                  (UserPromptSubmit for terminal id: its prompt row was taken)
 *                { t: 'asking', id, on }              (a question or a plan to approve open in terminal id, or none)
 *                { t: 'hold-bind', holdId, id, kind, key, data } | { t: 'hold-pass', holdId, why }
 *                { t: 'hold-resolved', holdIds, why }  (what a held request is; its call settled)
 *                { t: 'reply', req, result }          (for a request that carried `req`; a preview's image bytes
 *                                                     are transferred, a copy: the service keeps its own)
 *                { t: 'log', level, msg }             (never transcript text, never a URL or a host)
 *
 * Link previews (linkPreview.cjs over linkFetch.cjs) are fetched here and nowhere else, only while main says
 * they are on; the modules are loaded the first time they are, so a worker with previews off never has them.
 */

const { parentPort } = require('worker_threads')
const os = require('os')
const path = require('path')
const { createLens } = require('./chatLens.cjs')
const { errWord } = require('./chatLog.cjs')
const { callKey } = require('../hooks/spawn-hook.cjs')

let lens = null

function post(m, transfer) {
  try { if (transfer) parentPort.postMessage(m, transfer); else parentPort.postMessage(m) } catch { /* main is gone */ }
}

// ---- link previews: the policy main sent, and the service, made the first time previews are on
let previewPolicy = { allowLoopback: false, on: false }
let previews = null
function previewService() {
  if (!previews) {
    const { createPreviewService } = require('./linkPreview.cjs')
    const { previewOf, refusalLog } = require('./linkFetch.cjs')
    // (a refusal's kind in fixed words, counted, once a minute: never the URL, the host or the page's text)
    const note = refusalLog({ write: (msg) => post({ t: 'log', level: 'info', msg }) })
    const allowLoopback = previewPolicy.allowLoopback === true
    // (signal: the service aborts a running fetch when previews go off or no open view wants it any more)
    previews = createPreviewService({ fetchCard: (url, signal) => previewOf(url, { allowLoopback, note, signal }) })
  }
  return previews
}
// A fault of the service (it failed to load, or threw) never stops the worker: the request answers { ok: false }
// and the log has fixed words, once per worker (never the error's text: it could hold a URL)
let previewFaulted = false
function previewFault() {
  if (previewFaulted) return
  previewFaulted = true
  post({ t: 'log', level: 'error', msg: 'link preview: the service failed' })
}
function setPreviews(on) {
  previewPolicy = { ...previewPolicy, on: on === true }
  try {
    if (previews) previews.setOn(previewPolicy.on)
    else if (previewPolicy.on) previewService().setOn(true)
  } catch {
    previews = null
    previewFault()
  }
}
/**
 * One card, or { ok: false } (off, refused, failed: silent); the image's bytes a copy, transferred. Only for a link
 * written in a finished answer of terminal `m.id`'s open view (the lens has the items).
 */
async function preview(m) {
  try {
    if (!previewPolicy.on || typeof m.url !== 'string' || typeof m.id !== 'string') { reply(m, { ok: false }); return }
    if (!lens || !lens.linkInView(m.id, m.url)) { reply(m, { ok: false }); return }
    const card = await previewService().get(m.url, m.id)
    if (!card || !previewPolicy.on) { reply(m, { ok: false }); return }
    const image = card.image ? { ...card.image, bytes: new Uint8Array(card.image.bytes) } : null
    reply(m, { ok: true, card: { ...card, image } }, image ? [image.bytes.buffer] : undefined)
  } catch {
    previewFault()
    reply(m, { ok: false })
  }
}

function fatal(err) {
  post({ t: 'log', level: 'error', msg: `chat worker: stopped (${errWord(err)})` })
  process.exit(1)
}
process.on('uncaughtException', fatal)
process.on('unhandledRejection', fatal)

function reply(m, result, transfer) {
  if (m.req !== undefined) post({ t: 'reply', req: m.req, result }, transfer)
}

parentPort.on('message', async (m) => {
  if (!m || typeof m !== 'object') return
  switch (m.t) {
    case 'init':
      if (lens) lens.dispose()
      lens = createLens({
        claudeDir: (typeof m.claudeDir === 'string' && m.claudeDir) || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
        userDataDir: m.userDataDir,
        version: typeof m.version === 'string' ? m.version : null,
        emit: (update) => post({ t: 'update', update }),
        callKey,
        log: (level, msg) => post({ t: 'log', level, msg: String(msg) }),
        // UserPromptSubmit mapped to this terminal: main's ledger of its prompt row hears it
        onPrompt: (id) => post({ t: 'prompt', id }),
        // a question or a plan to approve open in this terminal (on), or none any more: main holds the composer's Enter
        onAsking: (id, on) => post({ t: 'asking', id, on: on === true }),
        // a held request bound or passed, a call settled (main answers or releases the hold)
        onHold: (m) => post(m),
      })
      // the previews' policy: the test switch (main reads it only in a development build) and on / off
      if (previews) { try { previews.setOn(false) } catch { /* (its fault: let go all the same) */ } previews = null }
      previewPolicy = { allowLoopback: m.preview?.allowLoopback === true, on: false }
      setPreviews(m.preview?.on === true)
      return
    case 'terminals': lens?.setTerminals(m.list); return
    // (Claude Code's binary changed while the worker runs: the open views' note follows; chatHost.cjs apply)
    case 'version': lens?.setVersion(typeof m.version === 'string' ? m.version : null); return
    case 'hook': {
      // main sends the raw bytes (it never parses a body); a body that is not JSON is dropped
      let body = m.body
      if (m.raw instanceof Uint8Array) { try { body = JSON.parse(Buffer.from(m.raw.buffer, m.raw.byteOffset, m.raw.byteLength).toString('utf8')) } catch { body = null } }
      const hold = typeof m.hold === 'string' ? m.hold : undefined
      // a held request with nobody to read it: handed back at once (main releases it)
      if (!lens) { if (hold) post({ t: 'hold-pass', holdId: hold, why: 'no-reader' }); return }
      lens.hook(m.event, body, m.at, hold, typeof m.id === 'string' ? m.id : undefined)
      return
    }
    case 'hold-state': lens?.holdState(m.holdId, m.state, m.choice); return
    case 'open': lens?.open(m.id); return
    // (a view closed: the previews only it wanted stop at once, their sockets destroyed)
    case 'close': lens?.close(m.id); try { previews?.release(m.id) } catch { /* (its fault: nothing to stop) */ } return
    case 'older': reply(m, lens ? await lens.older(m.id) : { ok: false, loaded: 0 }); return
    case 'reload': reply(m, lens ? await lens.reload(m.id) : { ok: false }); return
    case 'resync': reply(m, lens ? await lens.resync(m.id) : { ok: false }); return
    case 'agent': reply(m, lens ? await lens.agent(m.id, m.toolId) : { ok: false }); return
    // the change index (counts and offsets; a file's edits read again from the transcript)
    case 'changes': reply(m, lens ? await lens.changes(m.id) : { ok: false }); return
    case 'change-file': reply(m, lens ? await lens.changeFile(m.id, m.file, m.before) : { ok: false, reason: 'gone' }); return
    // "전체 보기": one item read again whole
    case 'full': reply(m, lens ? await lens.full(m.id, m.itemId) : { ok: false, reason: 'gone' }); return
    case 'picture': reply(m, lens ? await lens.picture(m.id, m.path) : { ok: false, reason: 'gone' }); return
    // link previews (only while main says they are on)
    case 'preview': await preview(m); return
    case 'previews': setPreviews(m.on === true); return
    default:
  }
})
