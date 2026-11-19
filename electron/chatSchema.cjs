'use strict'

/**
 * chatSchema.cjs — what a line of a Claude Code session transcript is, and
 * whether it has the shape the chat lens relies on (the chat view).
 *
 * The transcript (~/.claude/projects/<project>/<session>.jsonl) is Claude
 * Code's own internal format: one JSON object per line, mostly bookkeeping
 * (≈30 lines and hundreds of KB per turn). Only user / assistant / system
 * lines carry the conversation. The bookkeeping is recognised from the first
 * characters of a line and skipped without parsing (quickSkip), so a big
 * session costs little. Every kept line is checked (checkLine): a hard problem
 * means the lens cannot trust what it shows and says so (banner `schema`);
 * soft problems (a kind it does not know) are counted.
 *
 * Pure: no IO, no state.
 */

/** Top-level line types that never carry the conversation (bookkeeping) */
const NOISE_TYPES = [
  'file-history-snapshot', 'file-history-delta', 'queue-operation', 'last-prompt', 'ai-title', 'tools-used',
  'cost-state', 'mode', 'permission-mode', 'session-owner', 'atis-latch', 'api-request', 'api-request-shape',
  'api-request-blob', 'custom-title', 'summary',
  // (2.1.325, seen in the first real session: one per request, account ids only)
  'bridge-session',
]

/**
 * Attachment kinds shown in the chat; every other attachment line is skipped
 * unparsed. `queued_command`: a prompt the user sent while Claude worked, taken
 * into the running turn (2.1.325 writes it as this attachment, never as a user
 * line), shown as the user's message (chatItems.cjs).
 */
const KEEP_ATTACHMENTS = new Set(['queued_command'])

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/**
 * Bookkeeping skipped unparsed. `queue-operation` is bookkeeping for the conversation, but the
 * composer's strip reads it (what Claude Code itself queued: queueOp), so it is let through.
 */
const QUICK_SKIP_TYPES = NOISE_TYPES.filter(t => t !== 'queue-operation')
const NOISE_START = new RegExp(`^\\{"type":"(${QUICK_SKIP_TYPES.map(escapeRe).join('|')})"`)
const ATTACHMENT = /"attachment":\{"type":"([^"]*)"/

/**
 * A line the lens never needs, told from its first characters without a parse:
 * a bookkeeping type at the very start (first 64 characters), or an attachment
 * (`"attachment":{"type":"` in the first 256) of a kind not kept.
 */
function quickSkip(raw) {
  if (typeof raw !== 'string') return true
  if (NOISE_START.test(raw.slice(0, 64))) return true
  const m = ATTACHMENT.exec(raw.slice(0, 256))
  return !!m && !KEEP_ATTACHMENTS.has(m[1])
}

/** The kind of a parsed line */
function classify(obj) {
  const t = obj && typeof obj === 'object' ? obj.type : undefined
  if (t === 'user' || t === 'assistant' || t === 'system' || t === 'attachment') return t
  if (NOISE_TYPES.includes(t)) return 'noise'
  return 'unknown'
}

const KNOWN_BLOCKS = new Set(['text', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking', 'image', 'document'])
const hard = (problem) => ({ hard: true, problem })
const soft = (problem) => ({ hard: false, problem })

/**
 * The first problem with a parsed line, or null.
 * hard: a user/assistant line without a string uuid, an object message or a
 *   string/array content; a tool_use without a string id and name; a
 *   tool_result without a string tool_use_id; a text block whose text is not
 *   a string. The lens cannot draw such a line faithfully.
 * soft: an unknown top-level type, an unknown content block, a system line
 *   without a subtype. Shown as "can't show this here", counted.
 */
function checkLine(obj) {
  const kind = classify(obj)
  if (kind === 'unknown') return soft(`unknown line type ${JSON.stringify(obj && typeof obj === 'object' ? obj.type : typeof obj).slice(0, 40)}`)
  if (kind === 'system') return typeof obj.subtype === 'string' ? null : soft('system line without a subtype')
  if (kind !== 'user' && kind !== 'assistant') return null
  if (typeof obj.uuid !== 'string') return hard(`${kind} line without a uuid`)
  const msg = obj.message
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return hard(`${kind} line without a message`)
  const content = msg.content
  if (typeof content === 'string') return null
  if (!Array.isArray(content)) return hard(`${kind} message content is neither text nor a list`)
  let unknown = null
  for (const block of content) {
    if (!block || typeof block !== 'object') return hard('a content block that is not an object')
    switch (block.type) {
      case 'text':
        if (typeof block.text !== 'string') return hard('a text block without text')
        break
      case 'tool_use':
        if (typeof block.id !== 'string' || typeof block.name !== 'string') return hard('a tool_use without an id or a name')
        break
      case 'tool_result':
        if (typeof block.tool_use_id !== 'string') return hard('a tool_result without a tool_use_id')
        break
      default:
        if (!KNOWN_BLOCKS.has(block.type)) unknown ??= soft(`unknown content block ${JSON.stringify(block.type).slice(0, 40)}`)
    }
  }
  return unknown
}

/**
 * The Claude Code versions the lens was checked against: the spike ran on
 * 2.1.323 (spike/chat-lens/FINDINGS.md: transcript shapes, hook payloads,
 * MessageDisplay, HTTP hooks). To widen the range, rerun the spike scripts
 * (lens-driver.cjs, samples.cjs) on the new version first and compare.
 */
const SUPPORTED = Object.freeze({ min: '2.1.323', below: '2.2.0' })

const parse = (v) => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2])

/**
 * A Claude Code version (as `claude --version` prints it: "2.1.323 (Claude
 * Code)") against SUPPORTED: ok inside, new at or above `below`, old under
 * `min`, unknown when no version can be read.
 */
function versionVerdict(v) {
  const n = parse(v)
  if (!n) return 'unknown'
  if (cmp(n, parse(SUPPORTED.min)) < 0) return 'old'
  if (cmp(n, parse(SUPPORTED.below)) >= 0) return 'new'
  return 'ok'
}

/**
 * A `queue-operation` line (what Claude Code queued while it worked): `enqueue` (verified),
 * `remove` (verified on 2.1.325, e.g. `absorbed_mid_turn`), `dequeue` (assumed: the same
 * shape as enqueue); any other operation is `unknown`. The text from `content` (a string,
 * capped at 400), else null.
 */
function queueOp(obj) {
  const o = obj && typeof obj === 'object' ? obj.operation : undefined
  const op = o === 'enqueue' || o === 'remove' || o === 'dequeue' ? o : 'unknown'
  const text = typeof obj?.content === 'string' ? obj.content.slice(0, 400) : null
  return { op, text }
}

module.exports = { NOISE_TYPES, KEEP_ATTACHMENTS, quickSkip, classify, checkLine, SUPPORTED, versionVerdict, queueOp }
