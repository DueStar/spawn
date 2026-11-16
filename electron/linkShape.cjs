'use strict'

/**
 * linkShape.cjs — which links may get a preview card at all (the final review's I1). Pure: no require, no I/O.
 *
 * A link in an answer was written by Claude Code, and what Claude Code writes can be steered by what it read (a web
 * page, a README, a tool's result). Text that tells it to "cite https://site.example/x?d=<a key from .env>" would,
 * with previews on, send that key to the site the moment the row is on screen: nobody clicks anything. So a card is
 * only ever asked for a link whose address carries nothing a conversation could have put into it:
 *
 *   - http or https, at most 2048 characters, parsed by WHATWG URL;
 *   - no query string (not even an empty `?`), no userinfo (`user:pass@`), no port other than the scheme's default;
 *   - a path of at most 200 characters (percent-decoded), and no segment of it that looks like data: longer than 64
 *     characters, mostly hex digits (at least 16 letters and digits, 90 % of them hex), base64-like (at least 16
 *     letters and digits, upper and lower case and digits mixed, the kind changing at 45 % of the places or more),
 *     or a run of 32 letters and digits with no separator;
 *   - no label of the host that looks like data by the same test (a name is looked up through DNS before any
 *     request, and the lookup reaches the name's own server).
 * The fragment (`#…`) is never sent, so it is not judged. Such links stay plain links.
 *
 * The same rule is written for the page in src/chat/preview.ts (previewable); tests/link-shape.test.ts runs one
 * table through both. It is checked in the page (no card is asked for), in main before anything reaches the worker
 * (chatHost.cjs preview), and in the worker before any DNS lookup (linkFetch.cjs previewOf).
 *
 * `allowLoopback` (the test switch, set by main only in an unpackaged build): a port other than the default is let
 * through here; linkFetch.cjs checkUrl then allows it only when every address is a loopback one.
 */

/** The limits of the rule */
const SHAPE = Object.freeze({ urlChars: 2048, path: 200, segment: 64, dataChars: 16, hexShare: 0.9, mixShare: 0.45, run: 32 })

const no = (why) => ({ ok: false, why })
const AUTHORITY = /^[a-zA-Z][a-zA-Z0-9+.-]*:[\\/]*([^\\/?#]*)/

function decoded(s) {
  try { return decodeURIComponent(s) } catch { return s }
}

/** 'u' upper, 'l' lower, 'd' digit */
const kindOf = (c) => (c >= 48 && c <= 57 ? 'd' : c >= 65 && c <= 90 ? 'u' : 'l')

/** A path segment or a host label (as written in the URL) that looks like data rather than a name */
function looksLikeData(raw) {
  const s = decoded(String(raw))
  if (Array.from(s).length > SHAPE.segment) return true
  if (new RegExp(`[A-Za-z0-9]{${SHAPE.run},}`).test(s)) return true
  const an = s.replace(/[^A-Za-z0-9]/g, '')
  if (an.length < SHAPE.dataChars) return false
  let hex = 0
  for (let i = 0; i < an.length; i++) if (/[0-9a-fA-F]/.test(an[i])) hex++
  if (hex / an.length >= SHAPE.hexShare) return true
  if (/[A-Z]/.test(an) && /[a-z]/.test(an) && /[0-9]/.test(an)) {
    let changes = 0
    for (let i = 1; i < an.length; i++) if (kindOf(an.charCodeAt(i)) !== kindOf(an.charCodeAt(i - 1))) changes++
    if (changes / (an.length - 1) >= SHAPE.mixShare) return true
  }
  return false
}

/**
 * Whether a link may get a card. → { ok: true } | { ok: false, why } (why: shape | scheme | userinfo | query |
 * port | path | data). Nothing is looked up.
 */
function previewShape(raw, opts = {}) {
  if (typeof raw !== 'string' || !raw || raw.length > SHAPE.urlChars) return no('shape')
  if (!/^https?:\/\/[^/?#]/i.test(raw)) return no('shape')
  let u
  try { u = new URL(raw) } catch { return no('shape') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return no('scheme')
  const auth = AUTHORITY.exec(raw)
  if (u.username || u.password || (auth && auth[1].includes('@'))) return no('userinfo')
  const hash = raw.indexOf('#')
  if (u.search || (hash < 0 ? raw : raw.slice(0, hash)).includes('?')) return no('query')
  if (u.port !== '' && !(opts && opts.allowLoopback === true)) return no('port')
  const host = u.hostname
  if (!host.startsWith('[') && !/^[0-9.]+$/.test(host)) {
    for (const label of host.split('.')) if (label && looksLikeData(label)) return no('data')
  }
  const path = u.pathname
  if (Array.from(decoded(path)).length > SHAPE.path) return no('path')
  for (const seg of path.split('/')) if (seg && looksLikeData(seg)) return no('data')
  return { ok: true }
}

module.exports = { SHAPE, previewShape, looksLikeData }
