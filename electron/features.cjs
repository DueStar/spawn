'use strict'

/**
 * features.cjs — switches for whole features, read from features.json (the
 * page reads the same file through src/features.ts, so there is one value).
 *
 * OTHER_TOOLS: AI tools other than Claude Code (Codex CLI, tools added in
 * 설정 › AI 도구). Hidden by default: off, every
 * session runs Claude Code (or the plain shell), the 설정 section, the tool
 * picker, Codex's usage rows and its log watcher are gone, and the stored
 * tools / default tool / Codex tabs in the reopen list are kept as they are.
 * Flip `otherTools` to true in features.json to bring it all back.
 *
 * CHAT_VIEW: the chat view of a Claude Code session (a read-only
 * lens). Off, nothing of it runs: no chat hooks in the session settings, no
 * endpoint, no worker, no 설정 row (the app is release 1.4.0). On, it still
 * waits for 설정 › 세션 › 채팅으로 보기 (off by default). SPAWN_CHAT_VIEW=1
 * turns the switch on for development runs and tests only: never in a
 * packaged (installed) app, so a release that ships the switch off cannot be
 * turned on from the environment.
 */

const FEATURES = require('./features.json')

const OTHER_TOOLS = FEATURES.otherTools === true

/**
 * An installed (packaged) app, or one this cannot tell: no environment variable switches a feature on there.
 * Plain Node (the tests) is not one: there `require('electron')` is the npm package, the binary's path (a string).
 */
function packaged() {
  let electron
  try { electron = require('electron') } catch { return true }
  if (typeof electron === 'string') return false
  return !(electron && electron.app && electron.app.isPackaged === false)
}

// (the environment variable is for development runs and tests only)
const CHAT_VIEW = FEATURES.chatView === true || (process.env.SPAWN_CHAT_VIEW === '1' && !packaged())

module.exports = { OTHER_TOOLS, CHAT_VIEW, packaged }
