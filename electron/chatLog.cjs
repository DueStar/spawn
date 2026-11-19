'use strict'

/**
 * chatLog.cjs — what the chat view's log lines may say about an error: a fixed word, never its message.
 *
 * An error's message can hold a file name (fs: "ENOENT: no such file or directory, open '…'"), a URL, or text
 * from a transcript. The chat's log lines (spawn.log) carry only fixed words and numbers, so an error is named
 * by its code (ENOENT, EACCES, ERR_…) or its kind (TypeError, SyntaxError), else just "error".
 * (tests/chat-ui.test.ts checks every log line's template of electron/chat*.cjs and electron/link*.cjs.)
 */

/** @param {unknown} err  @returns {string} a code, a kind, or 'error' */
function errWord(err) {
  const code = err && typeof err === 'object' ? /** @type {any} */ (err).code : undefined
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(code)) return code
  const name = err && typeof err === 'object' ? /** @type {any} */ (err).name : undefined
  if (typeof name === 'string' && /^[A-Z][A-Za-z]{0,39}$/.test(name)) return name
  return 'error'
}

/**
 * A `claude --version` line as a log line may name it: its version number only (digits and
 * dots, as `2.1.325`), or 'unknown'; never the rest of the line as the binary printed it.
 * @param {unknown} v  @returns {string}
 */
function versionWord(v) {
  const m = typeof v === 'string' ? /^\s*v?(\d{1,4}(?:\.\d{1,6}){1,3})(?![\d.])/.exec(v) : null
  return m ? m[1] : 'unknown'
}

module.exports = { errWord, versionWord }
