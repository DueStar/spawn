/**
 * Link preview cards, the page's side (opt-in: 설정 › 세션 › 링크 미리보기, with 채팅으로 보기 on).
 *
 * The page never fetches anything for a card. A mounted LinkCard asks main (`chat.preview`), main asks the chat
 * worker, which fetches under the preview policy (electron/linkFetch.cjs, linkPreview.cjs). What comes back is
 * checked again here; its picture's bytes are shown only from a `blob:` URL this page made (decoded in the
 * sandboxed renderer), never from a remote address.
 *
 *   cardLinks   which links of a finished answer get a card: link and bare-address nodes of the prose (never inline
 *               code or a code block) that pass `previewable` (no query string, no userinfo, no port, no long or
 *               data-like path), the first 3 distinct URLs of the text, each card after the
 *               top-level block holding the link's first use (keyed by the block's stable key, markdown.ts blockKeys)
 *   hostLine    the card's site line: always the link's own host (Unicode with the punycode beside when not ASCII);
 *               what the page calls itself (og:site_name) is never shown, so a page cannot make a card name another
 *               site
 *   the cache   at most 120 cards, held for the views that showed them (a terminal's id); a card's blob: URL is
 *               revoked when the card is evicted, when every view that held it goes (a flip, a switch, the chat
 *               closed: releasePreviews; onChatForget), and when previews go off (dropPreviews). A failure is kept
 *               too (nothing shown, not asked again while kept), except main's `again` (it gave up waiting for the
 *               worker's queue): that one is let go, and the card asks again when it mounts next. Memory only.
 */

import { useEffect, useSyncExternalStore } from 'react'
import { bridge } from '../desktop'
import { blockKeys, type Block, type Inline } from './markdown'
import { onChatForget } from './lensMode'
import type { LinkCardData } from './types'

/** The page's cards at most */
export const PAGE_CARDS = 120
/** Cards per answer at most */
export const CARDS_PER_TEXT = 3
/** The longest address main asks the worker about (chatHost.cjs) */
const URL_MAX = 2048
const IMAGE_TYPES = new Set(['png', 'jpeg', 'webp'])

/** A card as the page draws it */
export interface ShownCard {
  url: string                 // the link as written (what a click opens)
  host: string                // the site line: the link's own host
  via: string | null          // the final host when a redirect left the link's host
  title: string; description: string
  src: string | null          // a blob: URL this page made from the picture's bytes, or none
}

// ---------------------------------------------------------------- which links

/** The limits of the rule below (the same numbers as electron/linkShape.cjs SHAPE) */
const SHAPE = { path: 200, segment: 64, dataChars: 16, hexShare: 0.9, mixShare: 0.45, run: 32 } as const
const AUTHORITY = /^[a-zA-Z][a-zA-Z0-9+.-]*:[\\/]*([^\\/?#]*)/
const RUN = new RegExp(`[A-Za-z0-9]{${SHAPE.run},}`)

function decoded(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}
const kindOf = (c: number) => (c >= 48 && c <= 57 ? 'd' : c >= 65 && c <= 90 ? 'u' : 'l')

/** A path segment or a host label that looks like data rather than a name (electron/linkShape.cjs looksLikeData) */
export function looksLikeData(raw: string): boolean {
  const s = decoded(String(raw))
  if (Array.from(s).length > SHAPE.segment) return true
  if (RUN.test(s)) return true
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
 * Whether a link may get a card at all (electron/linkShape.cjs previewShape is the same rule,
 * checked again in main and in the worker). A card is fetched as soon as its row has been on screen a moment, with
 * nobody clicking, and the whole address goes to that site: so only a link that carries nothing a conversation could
 * have put into it. http or https, at most 2048 characters; no query string (not even an empty `?`), no userinfo,
 * no port but the scheme's own; a path of at most 200 characters with no segment, and a host with no label, that
 * looks like data (longer than 64 characters, mostly hex, base64-like, or 32 letters and digits in a row). The
 * fragment is never sent. Anything else stays a plain link.
 */
export function previewable(href: string): boolean {
  if (typeof href !== 'string' || !href || href.length > URL_MAX || !/^https?:\/\/[^/?#]/i.test(href)) return false
  let u: URL
  try { u = new URL(href) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const auth = AUTHORITY.exec(href)
  if (u.username || u.password || (auth && auth[1].includes('@'))) return false
  const hash = href.indexOf('#')
  if (u.search || (hash < 0 ? href : href.slice(0, hash)).includes('?')) return false
  if (u.port !== '') return false
  const host = u.hostname
  if (!host.startsWith('[') && !/^[0-9.]+$/.test(host)) {
    for (const label of host.split('.')) if (label && looksLikeData(label)) return false
  }
  const path = u.pathname
  if (Array.from(decoded(path)).length > SHAPE.path) return false
  for (const seg of path.split('/')) if (seg && looksLikeData(seg)) return false
  return true
}

function inlineHrefs(xs: Inline[], out: string[]): void {
  for (const x of xs) {
    if (x.type === 'link' || x.type === 'autolink') out.push(x.href)
    else if (x.type === 'strong' || x.type === 'em' || x.type === 'del') inlineHrefs(x.children, out)
    // (inline code, a file path, text: no link)
  }
}

function blockHrefs(b: Block, out: string[]): void {
  switch (b.type) {
    case 'para': case 'heading': inlineHrefs(b.inline, out); return
    case 'list': for (const item of b.items) for (const x of item) blockHrefs(x, out); return
    case 'quote': for (const x of b.blocks) blockHrefs(x, out); return
    case 'table':
      for (const c of b.head) inlineHrefs(c, out)
      for (const r of b.rows) for (const c of r) inlineHrefs(c, out)
      return
    default: // a code block, a rule, the cut note: never a link
  }
}

/** The links of an answer that get a card: block key → its URLs (the first `max` distinct of the text, in order) */
export function cardLinks(blocks: Block[], max = CARDS_PER_TEXT): Map<string, string[]> {
  const keys = blockKeys(blocks)
  const out = new Map<string, string[]>()
  const seen = new Set<string>()
  for (let i = 0; i < blocks.length && seen.size < max; i++) {
    const hrefs: string[] = []
    blockHrefs(blocks[i], hrefs)
    for (const href of hrefs) {
      if (seen.size >= max) break
      if (seen.has(href) || !previewable(href)) continue
      seen.add(href)
      out.set(keys[i], [...(out.get(keys[i]) ?? []), href])
    }
  }
  return out
}

// ---------------------------------------------------------------- the site line

/** A character never shown in a host: controls, spaces, brackets, bidi, zero-width and other invisible marks */
function hiddenIn(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c <= 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0xad || c === 0x61c || c === 0x180e || (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff || c === 0x28 || c === 0x29) return true
  }
  return false
}

/**
 * The card's site line for `url`: the worker's `site` only when it is the URL's own host, or that host's Unicode
 * form with its punycode beside (checked: the Unicode form's ASCII form is the host); otherwise the host as the
 * URL itself gives it. '' for no URL.
 */
export function hostLine(url: string, site: string): string {
  let ascii: string
  try { ascii = new URL(url).hostname.toLowerCase().replace(/\.$/, '') } catch { return '' }
  if (!ascii) return ''
  if (typeof site !== 'string' || site === ascii) return ascii
  const tail = ` (${ascii})`
  if (ascii.includes('xn--') && site.endsWith(tail)) {
    const uni = site.slice(0, -tail.length)
    if (uni && !hiddenIn(uni)) {
      try { if (new URL(`http://${uni}/`).hostname.replace(/\.$/, '') === ascii) return site } catch { /* not a host */ }
    }
  }
  return ascii
}

// ---------------------------------------------------------------- the page's cache

type Answer = { ok: true; card: LinkCardData } | { ok: false; again?: true }
interface Entry { card: ShownCard | null; owners: Set<string> }

/**
 * The page's cards (pure over `ask`, `makeUrl`, `revoke`, for the tests): asked once per URL, held for their
 * owners (the views that showed them), at most `cap`, least recently wanted first out.
 */
export function createPageCache({ ask, makeUrl, revoke, cap = PAGE_CARDS }: {
  /** main is asked for `url`'s card for the view of terminal `owner` (main checks the link is in that view's answers) */
  ask: (url: string, owner: string) => Promise<Answer>
  makeUrl: (bytes: Uint8Array, type: string) => string
  revoke: (src: string) => void
  cap?: number
}) {
  const entries = new Map<string, Entry>()
  const listeners = new Set<() => void>()
  let gen = 0
  const changed = () => { for (const fn of [...listeners]) fn() }

  function drop(url: string): void {
    const e = entries.get(url)
    if (!e) return
    entries.delete(url)
    if (e.card?.src) revoke(e.card.src)
  }

  /** The worker's card as the page draws it (checked again), its picture as a blob: URL made here */
  function shown(c: LinkCardData | undefined, url: string): ShownCard | null {
    if (!c || typeof c !== 'object' || c.url !== url) return null
    if (typeof c.title !== 'string' || typeof c.description !== 'string' || typeof c.site !== 'string') return null
    if (!c.title && !c.description) return null
    const host = hostLine(url, c.site)
    if (!host) return null
    // (the final host as the worker named it: `host` or `unicode (punycode)`, nothing hidden in it)
    const via = typeof c.via === 'string' && c.via.length > 0 && c.via.length <= 300 && !hiddenIn(c.via.replace(/^(\S+) \((\S+)\)$/, '$1$2')) ? c.via : null
    const i = c.image
    const image = i && IMAGE_TYPES.has(i.type) && i.bytes instanceof Uint8Array && i.bytes.byteLength > 0 ? i : null
    return { url, host, via, title: c.title, description: c.description, src: image ? makeUrl(image.bytes, image.type) : null }
  }

  /**
   * A mounted card of view `owner` wants `url`'s card: asked once (a failure is kept too, except one that says
   * `again`: main gave up waiting for the worker, nothing about the link; the next mount asks again)
   */
  function want(url: string, owner: string): void {
    const had = entries.get(url)
    if (had) {
      had.owners.add(owner)
      entries.delete(url)
      entries.set(url, had)
      return
    }
    const entry: Entry = { card: null, owners: new Set([owner]) }
    entries.set(url, entry)
    while (entries.size > cap) drop(entries.keys().next().value as string)
    const g = gen
    let p: Promise<Answer>
    try { p = ask(url, owner) } catch { p = Promise.resolve({ ok: false }) }
    Promise.resolve(p).then((r) => r, () => null).then((r) => {
      // (previews went off, or every view that wanted it went, or it was evicted meanwhile: nothing is made)
      if (g !== gen || entries.get(url) !== entry) return
      if (r && r.ok === false && r.again === true) { entries.delete(url); return }
      entry.card = r && r.ok === true ? shown(r.card, url) : null
      if (entry.card) changed()
    })
  }

  /** The card to draw for `url` (null: not here yet, failed, or gone) */
  const card = (url: string): ShownCard | null => entries.get(url)?.card ?? null

  /** View `owner` went: the cards no other view holds go, their blob: URLs revoked */
  function release(owner: string): void {
    let any = false
    for (const [url, e] of [...entries]) {
      if (!e.owners.delete(owner) || e.owners.size) continue
      drop(url)
      any = true
    }
    if (any) changed()
  }

  /** Previews went off: every card goes, every blob: URL revoked; an answer still on its way makes nothing */
  function dropAll(): void {
    gen++
    if (!entries.size) return
    for (const url of [...entries.keys()]) drop(url)
    changed()
  }

  const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
  return { want, card, release, dropAll, subscribe, size: () => entries.size }
}

// the page's one cache: main is asked (never fetch), the picture's bytes made into a blob: URL here
const pageCache = createPageCache({
  ask: (url, owner) => (bridge?.chat?.preview ? bridge.chat.preview({ id: owner, url }) : Promise.resolve({ ok: false as const })),
  makeUrl: (bytes, type) => URL.createObjectURL(new Blob([bytes as BlobPart], { type: `image/${type}` })),
  revoke: (src) => { try { URL.revokeObjectURL(src) } catch { /* gone already */ } },
})
onChatForget(id => pageCache.release(id))

/** The view of terminal `id` went (a flip, a switch, the chat closed): its cards and their blob: URLs go */
export const releasePreviews = (id: string): void => pageCache.release(id)
/** Previews went off: every card and blob: URL goes */
export const dropPreviews = (): void => pageCache.dropAll()

/**
 * How long a card stays mounted before it asks: a row the virtual list mounts for a moment only (its first render
 * from the top before it jumps to the end, a row a quick scroll flies past) asks nothing
 */
export const SETTLE_MS = 200

/**
 * The card for `url` in view `owner` (a terminal's id), or null until it arrives (and on failure). Only a mounted
 * LinkCard calls this: the ask is made in its effect once it has stayed mounted SETTLE_MS, so a row the virtual list
 * never drew, or drew only in passing, asks nothing.
 */
export function usePreview(url: string, on: boolean, owner: string): ShownCard | null {
  useEffect(() => {
    if (!on || !url || !owner) return
    const timer = setTimeout(() => pageCache.want(url, owner), SETTLE_MS)
    return () => clearTimeout(timer)
  }, [on, url, owner])
  return useSyncExternalStore(pageCache.subscribe, () => (on ? pageCache.card(url) : null), () => null)
}
