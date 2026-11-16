/**
 * electron/links.cjs — a file named in a session's output: where it is, and the editor link
 * that opens it. The platform is a parameter so both can be tested on any OS.
 */

const os = require('node:os')
const path = require('node:path')
const { isMac } = require('./platform.cjs')

/**
 * The file a clicked reference means: resolved against the session's folder; on macOS a
 * ~/ path is in the home folder
 */
function resolveRef(cwd, file, { platform = process.platform, home = os.homedir() } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix
  if (isMac(platform) && file.startsWith('~/')) return p.join(home, file.slice(2))
  return p.resolve(cwd, file)
}

/**
 * vscode://file/C:/a/x.ts or vscode://file/Users/a/x.ts (cursor:// the same): each part of
 * the path encoded, forward slashes, and no double slash after file/ for a / path
 */
function vscodeUrl(abs, { scheme = 'vscode', platform = process.platform } = {}) {
  const parts = abs.split(platform === 'win32' ? /[\\/]/ : '/')
  const joined = parts.map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:')
  return `${scheme}://file/${abs.startsWith('/') ? joined.slice(1) : joined}`
}

/**
 * A file named in the chat view (a path chip, a diff's file): opened in the code editor when one
 * answers vscode:// or cursor:// (at its line), else shown in its folder. Never the default app:
 * from the chat a click must not run a script (.cmd, .bat, .ps1, .js, .sh …), and the prose that
 * names a file can be steered by what Claude read. (A terminal's Ctrl+click keeps its own way.)
 */
function chatOpenPlan(abs, { line, col, hasScheme, platform = process.platform } = {}) {
  const at = `${Number(line) > 0 ? `:${Math.floor(Number(line))}` : ''}${Number(line) > 0 && Number(col) > 0 ? `:${Math.floor(Number(col))}` : ''}`
  for (const scheme of ['vscode', 'cursor']) {
    if (hasScheme?.(scheme)) return { url: `${vscodeUrl(abs, { scheme, platform })}${at}` }
  }
  return { folder: abs }
}

/**
 * A path the chat view never hands to the file system: a UNC share (\\host\share, //host/share)
 * or a device path (\\?\…, \\.\…, and their / spellings). Looking one up would make Windows
 * connect to that host with the user's credentials, and the prose naming it can be steered by
 * what Claude read. Lexical only: nothing is looked up to decide.
 */
const isRemotePath = (p) => typeof p === 'string' && /^[\\/]{2}/.test(p)

/**
 * A path chip or a diff's file clicked in the chat view (`term`: the session's terminal info):
 * its own checks first, before any file system call (a string of at most 1024 characters, no
 * UNC or device path, also once resolved against the session's folder), then a regular file
 * that exists, opened as chatOpenPlan says. Never runs it. Resolves true when something opened.
 */
async function openFromChat(term, file, { line, col, hasScheme, openExternal, showItemInFolder, statSync = require('node:fs').statSync, platform = process.platform, home } = {}) {
  if (!term || typeof file !== 'string' || !file || file.length > 1024 || file.includes('\0')) return false
  if (isRemotePath(file)) return false
  const abs = resolveRef(term.cwd, file, { platform, ...(home ? { home } : {}) })
  if (isRemotePath(abs)) return false
  try { if (!statSync(abs).isFile()) return false } catch { return false }
  const plan = chatOpenPlan(abs, { line, col, hasScheme, platform })
  if (plan.url) await openExternal(plan.url)
  else showItemInFolder(abs)
  return true
}

module.exports = { resolveRef, vscodeUrl, chatOpenPlan, isRemotePath, openFromChat }
