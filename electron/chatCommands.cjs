'use strict'

/**
 * chatCommands.cjs — the chat composer's / menu (2026-11-19): the commands and skills a Claude Code session can run
 * besides its own (the page holds Claude Code's built-ins: src/chat/slash.ts). Read by main, for the terminal's own
 * folder (never one the page names):
 *
 *   project  <cwd>/.claude/commands/**.md          /name (a subfolder: /folder:name)
 *   project  <cwd>/.claude/skills/<name>/SKILL.md  /name
 *   user     <config>/commands/**.md               (config: CLAUDE_CONFIG_DIR, else ~/.claude)
 *   skill    <config>/skills/<name>/SKILL.md
 *   plugin   each installed plugin's (installed_plugins.json's installPath):
 *            commands/**.md and skills/<name>/SKILL.md, as /plugin:name
 *
 * Only the start of each file is read (its front matter: name, description, argument-hint; a command with no
 * description: its first line of text). A skill marked `user-invocable: false` is left out. Symbolic links are not
 * followed into folders; at most 400 entries; every read is bounded by the time budget.
 */

const path = require('path')
const os = require('os')

const HEAD_BYTES = 4096
const MAX_ENTRIES = 400
const MAX_DEPTH = 3
const NAME = /^[A-Za-z0-9][\w.-]{0,62}$/

/** The first HEAD_BYTES of a file as text ('' when it cannot be read) */
async function head(fs, file) {
  let fh
  try {
    fh = await fs.open(file, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } catch { return '' } finally { try { await fh?.close() } catch { /* closed */ } }
}

const unquote = (v) => {
  const s = String(v ?? '').trim()
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    const inner = s.slice(1, -1)
    return s[0] === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner.replace(/''/g, "'")
  }
  return s
}

/**
 * A markdown file's front matter (the keys this menu needs; a folded `>` or `|` value joined into one line) and its
 * first line of text after it
 */
function frontMatter(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const out = { fields: {}, first: '' }
  let rest = src
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src)
  if (m) {
    rest = src.slice(m[0].length)
    const lines = m[1].split('\n')
    for (let i = 0; i < lines.length; i++) {
      const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i])
      if (!kv) continue
      let v = kv[2]
      if (/^[>|][-+]?\s*$/.test(v)) {
        const more = []
        while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) more.push(lines[++i].trim())
        v = more.filter(Boolean).join(' ')
      }
      out.fields[kv[1].toLowerCase()] = unquote(v)
    }
  }
  for (const l of rest.split('\n')) {
    const s = l.replace(/^#+\s*/, '').trim()
    if (s) { out.first = s; break }
  }
  return out
}

const oneLine = (s, max = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/** The .md files under `dir` (relative names with / for subfolders), real folders only, MAX_DEPTH deep */
async function mdFiles(fs, dir, depth = 0, rel = '') {
  let ents
  try { ents = await fs.readdir(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const d of ents) {
    if (d.isSymbolicLink() || d.name.startsWith('.')) continue
    if (d.isDirectory() && depth < MAX_DEPTH) out.push(...await mdFiles(fs, path.join(dir, d.name), depth + 1, rel ? `${rel}/${d.name}` : d.name))
    else if (d.isFile() && /\.md$/i.test(d.name)) out.push(rel ? `${rel}/${d.name}` : d.name)
  }
  return out
}

/** Commands from a commands folder: /a/b.md → a:b */
async function readCommands(fs, dir, kind, prefix = '') {
  const out = []
  for (const rel of await mdFiles(fs, dir)) {
    const parts = rel.replace(/\.md$/i, '').split('/')
    if (!parts.every(p => NAME.test(p))) continue
    const name = prefix + parts.join(':')
    const fm = frontMatter(await head(fs, path.join(dir, ...rel.split('/'))))
    out.push({ name, desc: oneLine(fm.fields.description || fm.first), kind, ...(fm.fields['argument-hint'] ? { hint: oneLine(fm.fields['argument-hint'], 80) } : {}) })
  }
  return out
}

/** Skills from a skills folder: <name>/SKILL.md */
async function readSkills(fs, dir, kind, prefix = '') {
  let ents
  try { ents = await fs.readdir(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const d of ents) {
    if (!d.isDirectory() || d.isSymbolicLink() || d.name.startsWith('.')) continue
    const text = await head(fs, path.join(dir, d.name, 'SKILL.md'))
    if (!text) continue
    const fm = frontMatter(text)
    if (String(fm.fields['user-invocable'] ?? '').toLowerCase() === 'false') continue
    const own = NAME.test(fm.fields.name ?? '') ? fm.fields.name : d.name
    if (!NAME.test(own)) continue
    out.push({ name: prefix + own, desc: oneLine(fm.fields.description || fm.first), kind, ...(fm.fields['argument-hint'] ? { hint: oneLine(fm.fields['argument-hint'], 80) } : {}) })
  }
  return out
}

async function readJson(fs, file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return null }
}

/**
 * The installed plugins' folders: [{ name, dir }]. Which are turned on is in Claude Code's settings file, which the
 * chat never reads (tests/chat-ui.test.ts): a plugin turned off still lists its skills (Claude Code says so if run).
 */
async function pluginDirs(fs, config) {
  const installed = await readJson(fs, path.join(config, 'plugins', 'installed_plugins.json'))
  const plugins = installed && typeof installed.plugins === 'object' && installed.plugins ? installed.plugins : {}
  const out = []
  for (const [key, list] of Object.entries(plugins)) {
    if (!Array.isArray(list) || !list.length) continue
    const name = key.split('@')[0]
    const dir = list[0] && typeof list[0].installPath === 'string' ? list[0].installPath : null
    if (!NAME.test(name) || !dir || !path.isAbsolute(dir)) continue
    out.push({ name, dir })
  }
  return out
}

/**
 * Every command and skill for a session in `cwd`: the project's, the user's, then the plugins'. A network folder
 * (\\server\share) is not read for the project's.
 */
async function listCommands(cwd, { fs = require('fs').promises, home = os.homedir(), env = process.env, config: configDir = null, budgetMs = 800, now = Date.now } = {}) {
  const start = now()
  const config = typeof configDir === 'string' && configDir ? configDir
    : typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : path.join(home, '.claude')
  const jobs = []
  if (typeof cwd === 'string' && cwd && !/^(?:\\\\|\/\/)/.test(cwd)) {
    jobs.push(() => readCommands(fs, path.join(cwd, '.claude', 'commands'), 'project'))
    jobs.push(() => readSkills(fs, path.join(cwd, '.claude', 'skills'), 'project'))
  }
  jobs.push(() => readCommands(fs, path.join(config, 'commands'), 'user'))
  jobs.push(() => readSkills(fs, path.join(config, 'skills'), 'skill'))
  jobs.push(async () => {
    const out = []
    for (const p of await pluginDirs(fs, config)) {
      if (now() - start > budgetMs) break
      out.push(...await readCommands(fs, path.join(p.dir, 'commands'), 'plugin', `${p.name}:`))
      out.push(...await readSkills(fs, path.join(p.dir, 'skills'), 'plugin', `${p.name}:`))
    }
    return out
  })
  const out = []
  const seen = new Set()
  for (const job of jobs) {
    if (now() - start > budgetMs || out.length >= MAX_ENTRIES) break
    let got = []
    try { got = await job() } catch { got = [] }
    for (const c of got) {
      if (seen.has(c.name) || out.length >= MAX_ENTRIES) continue
      seen.add(c.name)
      out.push(c)
    }
  }
  return out
}

module.exports = { listCommands, frontMatter, readCommands, readSkills, pluginDirs }
