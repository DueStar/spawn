/**
 * release-mac.mjs — the Mac half of a release. Off unless asked for: run by
 * scripts/release.mjs only with --publish --with-mac (the tag pushed and CI
 * started right after the preflight, startMacEarly, so the Macs build while
 * Windows does; waited for and uploaded once the Windows release is out,
 * finishMacRelease), or on its own with --mac-only for a release tag that is
 * already there (releaseMac: both halves in one go):
 *
 *   node scripts/release.mjs --publish --with-mac
 *   node scripts/release.mjs --mac-only <version>
 *
 * Macs are built by CI (.github/workflows/mac.yml), never on this PC: the run is
 * started on the release's tag (v<version>), so a retry after main has moved on
 * still builds the release's commit; it is found by that commit (its head sha)
 * and waited for, and its two artifacts (mac-arm64, mac-x64:
 * scripts/mac-build.mjs) downloaded into release/mac/<v>/. A workflow runs from
 * the file at the ref it is started on, so for the first Mac release mac.yml
 * must already be on main at that tag. Each arch is checked here (both zips
 * there, the update zip's sha256 recomputed, the smoke launch passed: a failed
 * or missing smoke launch always fails that arch), then gets its own
 * latest-mac-<arch>.json (scripts/manifest.mjs) with the Windows release's
 * notes and date, signed with the local key (it never goes to CI) and verified
 * with the key installed apps hold. The zips go up first and the manifests
 * last, so a manifest never names a zip that is not there yet.
 *
 * One arch that fails does not hold back the other; the run still ends as a
 * failure. Nothing here touches the Windows release.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { writeManifest } from './manifest.mjs'
import { macArtifactNames, VERSION } from './mac-build.mjs'
import { signManifest, signingKeyPath } from './signing.mjs'

const { manifestName, verifyManifest, REPO } = createRequire(import.meta.url)('../electron/updater.cjs')

export const MAC_ARCHES = ['arm64', 'x64']
const WORKFLOW = 'mac.yml'
// How long the started run may take to show up in `gh run list`
const FIND_TRIES = 24
const FIND_EVERY_MS = 5000
// mac.yml's step that launches the built app
export const SMOKE_STEP = 'Smoke launch'

/**
 * What release.mjs's arguments ask for. A test build (no --publish) is
 * Windows only; --publish is Windows only too, exactly as before the Macs;
 * --publish --with-mac is Windows, then the Macs; --mac-only <v> is the Macs
 * alone, for the release v<v> already on GitHub.
 */
export function parseReleaseArgs(argv) {
  const at = argv.indexOf('--mac-only')
  let macOnly = null
  if (at >= 0) {
    macOnly = argv[at + 1] ?? ''
    if (!VERSION.test(macOnly)) throw new Error(`--mac-only needs the version of a published release (like 1.3.49), not "${macOnly}"`)
  }
  const publish = argv.includes('--publish')
  const withMac = argv.includes('--with-mac')
  if (withMac && !publish && !macOnly) throw new Error('--with-mac goes with --publish (a test build is Windows only)')
  return {
    windows: !macOnly,
    mac: !!macOnly || (publish && withMac),
    macOnly,
    publish,
  }
}

const sha256Of = (fs, file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** sha256.txt's lines ("<sha256>  <file>", as shasum writes them) as { file: sha256 } */
function readSha256s(text) {
  const out = {}
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line)
    if (m) out[m[2]] = m[1].toLowerCase()
  }
  return out
}

/**
 * parseReleaseArgs for release.mjs: a bad argument is one line on stderr and
 * exit code 1, not a stack trace.
 */
export function releaseArgsOrExit(argv, { exit = process.exit, error = console.error } = {}) {
  try { return parseReleaseArgs(argv) } catch (err) {
    error(err.message)
    return exit(1)
  }
}

/**
 * One arch's downloaded artifact, checked: returns what its manifest needs,
 * or throws the reason it cannot be released (a failed or missing smoke
 * launch among them).
 */
function checkArch({ fs, dir, version, arch }) {
  const { appZip, fullZip } = macArtifactNames(version, arch)
  for (const f of [appZip, fullZip]) {
    if (!fs.existsSync(join(dir, f))) throw new Error(`${f} is not in the artifact`)
  }
  let sums = {}
  try { sums = readSha256s(fs.readFileSync(join(dir, 'sha256.txt'), 'utf8')) } catch { throw new Error('no sha256.txt in the artifact') }
  const sha = sha256Of(fs, join(dir, appZip))
  if (!sums[appZip]) throw new Error(`sha256.txt has no line for ${appZip}`)
  if (sums[appZip] !== sha) throw new Error(`sha256 mismatch for ${appZip}: CI says ${sums[appZip]}, the download is ${sha}`)
  if (sums[fullZip] && sums[fullZip] !== sha256Of(fs, join(dir, fullZip))) throw new Error(`sha256 mismatch for ${fullZip}`)
  let electron = ''
  try { electron = fs.readFileSync(join(dir, 'electron-version.txt'), 'utf8').trim() } catch {}
  if (!VERSION.test(electron)) throw new Error(`no Electron version in electron-version.txt (${electron || 'missing'})`)
  let smoke = null
  try { smoke = JSON.parse(fs.readFileSync(join(dir, 'smoke', 'smoke.json'), 'utf8')) } catch {}
  if (!(smoke && smoke.ok === true && smoke.done === true)) {
    throw new Error(smoke ? `the smoke launch failed (${smoke.failure || 'not passed'})` : 'no smoke.json: the smoke launch did not report')
  }
  return {
    electron,
    app: { file: appZip, sha256: sha, size: fs.statSync(join(dir, appZip)).size, path: join(dir, appZip) },
    full: { file: fullZip, size: fs.statSync(join(dir, fullZip)).size, path: join(dir, fullZip) },
  }
}

/** The Mac part's result so far, and how it ends in a failure of every arch not failed yet */
function tracker(log) {
  const t = { released: [], failed: [], zipsUploaded: [], manifestsRemoved: [], runId: null }
  t.result = () => ({ ok: t.failed.length === 0, released: t.released, failed: t.failed, zipsUploaded: t.zipsUploaded, manifestsRemoved: t.manifestsRemoved, ...(t.runId ? { runId: t.runId } : {}) })
  t.failAll = (version, reason) => {
    for (const arch of MAC_ARCHES) if (!t.failed.some(f => f.arch === arch)) t.failed.push({ arch, reason })
    log.error(`Mac release of ${version}: ${reason}`)
    return t.result()
  }
  return t
}

const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms))

/** The commit v<version> names on GitHub, or '' when there is no such tag */
async function tagShaOf(version, gh) {
  let sha = ''
  try { sha = String(await gh(['api', `repos/${REPO}/commits/v${version}`, '--jq', '.sha'])).trim() } catch {}
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : ''
}

/** Where a Mac CI run is seen */
export function macRunUrl(id) { return `https://github.com/${REPO}/actions/runs/${id}` }

/** How the pictures the smoke launch took of the built app are fetched (mac.yml's mac-screens-<arch>) */
export function macScreensHint(id) {
  return [
    `Mac screenshots (the built app, launched on the runner): ${macRunUrl(id)} (Artifacts), or`,
    ...MAC_ARCHES.map(arch => `  gh run download ${id} -R ${REPO} -n mac-screens-${arch} -D release/mac-screens/${arch}`),
  ].join('\n')
}

/**
 * mac.yml started on v<version> and its run found by the tag's commit: { id } or
 * { reason } (never throws). The tag is all CI needs: no release, no file of the
 * Windows build (the notes, date and signature are added here, after the run).
 */
async function dispatchMacRun(version, tagSha, { gh, sleep, log }) {
  const tag = `v${version}`
  // CI on the release's tag (not a branch, which may have moved on since); the run it
  // started is the new one in the list that builds the tag's commit
  const listArgs = ['run', 'list', '--repo', REPO, '--workflow', WORKFLOW, '--event', 'workflow_dispatch', '--limit', '20', '--json', 'databaseId,headSha,headBranch,event,createdAt']
  try {
    const before = new Set(JSON.parse(String(await gh(listArgs)) || '[]').map(r => r.databaseId))
    log.log(`Mac: starting ${WORKFLOW} on ${tag} for ${version}`)
    await gh(['workflow', 'run', WORKFLOW, '--repo', REPO, '--ref', tag, '-f', `version=${version}`])
    let runInfo = null
    let others = []
    const sameSha = (r) => String(r.headSha).toLowerCase() === tagSha.toLowerCase()
    for (let i = 0; i < FIND_TRIES && !runInfo; i++) {
      await sleep(FIND_EVERY_MS)
      const runs = JSON.parse(String(await gh(listArgs)) || '[]').filter(r => !before.has(r.databaseId)).sort((a, b) => b.databaseId - a.databaseId)
      runInfo = runs.find(sameSha) ?? null
      others = runs.filter(r => !sameSha(r))
    }
    if (!runInfo) {
      // The head sha check: a new run that builds another commit is never taken for ours
      if (others.length) return { reason: `CI run ${others[0].databaseId} builds ${String(others[0].headSha).slice(0, 7)} but ${tag} is ${tagSha.slice(0, 7)}: no run of ${WORKFLOW} built the release's commit` }
      return { reason: `the ${WORKFLOW} run did not show up within ${(FIND_TRIES * FIND_EVERY_MS) / 1000} s` }
    }
    const id = String(runInfo.databaseId)
    log.log(`Mac: CI run ${id} (${macRunUrl(id)})`)
    return { id }
  } catch (err) {
    return { reason: err.message }
  }
}

/**
 * The Mac build started early, while Windows builds (release.mjs --publish --with-mac):
 * v<version> must already be on GitHub (startMacEarly pushes it first). Resolves to
 * { id } or { reason }; never throws. finishMacRelease takes it from there.
 */
export async function startMacBuild(version, deps = {}) {
  const { run, sleep = defaultSleep, log = console } = deps
  const gh = (args, opts) => run('gh', args, opts)
  const tagSha = await tagShaOf(version, gh)
  if (!tagSha) return { reason: `no v${version} on GitHub: it is pushed before the Mac build starts` }
  return dispatchMacRun(version, tagSha, { gh, sleep, log })
}

/**
 * The second half of an early start: wait for the run startMacBuild found (or report
 * why it never started), check, sign and upload onto the release Windows has made by
 * now. Same deps and result as releaseMac; `notes` must be given.
 */
export async function finishMacRelease(version, started, deps = {}) {
  const { log = console, root, fs = nodeFs } = deps
  const t = tracker(log)
  if (!started?.id) return t.failAll(version, `the Mac build did not start: ${started?.reason ?? 'not started'}`)
  t.runId = started.id
  try {
    const out = join(root, 'release', 'mac', version)
    fs.rmSync(out, { recursive: true, force: true })
    fs.mkdirSync(out, { recursive: true })
    return await collectMacRun(version, started.id, deps, t)
  } catch (err) {
    return t.failAll(version, err.message)
  }
}

/**
 * Release the Macs for v<version> in one go (--mac-only). Every side effect comes in `deps`:
 *   run(cmd, args, { show })  gh and git; resolves to stdout, throws on a non-zero exit
 *   fs, sign(manifest), publicKey (the one manifests are verified with: the
 *   shipped one by default), log, sleep(ms), root (the repo), notes ({ notes,
 *   notesEn, notesJa, date } of the Windows manifest; null: read from the
 *   release's latest.json).
 * Resolves to { ok, released: [arch], failed: [{ arch, reason }], zipsUploaded:
 * [arch], manifestsRemoved: [arch], runId? } (zipsUploaded and manifestsRemoved say
 * what is on the release when it stopped half way); never throws.
 */
export async function releaseMac(version, deps = {}) {
  const { run, fs = nodeFs, log = console, sleep = defaultSleep, root, notes: givenNotes = null } = deps
  const tag = `v${version}`
  const out = join(root, 'release', 'mac', version)
  const t = tracker(log)
  const gh = (args, opts) => run('gh', args, opts)

  try {
    // The release's tag must be there: CI runs on it, and its commit is the one to build
    const tagSha = await tagShaOf(version, gh)
    if (!tagSha) return t.failAll(version, `no ${tag} on GitHub: the Windows release makes it first`)

    fs.rmSync(out, { recursive: true, force: true })
    fs.mkdirSync(out, { recursive: true })

    // The notes and date the Windows manifest went out with
    let notes = givenNotes
    if (!notes) {
      const winDir = join(out, 'windows')
      await gh(['release', 'download', tag, '--repo', REPO, '--pattern', 'latest.json', '--dir', winDir, '--clobber'])
      const win = JSON.parse(fs.readFileSync(join(winDir, 'latest.json'), 'utf8'))
      if (win.version !== version) return t.failAll(version, `${tag}'s latest.json is for ${win.version}`)
      notes = { notes: win.notes ?? '', notesEn: win.notesEn ?? '', notesJa: win.notesJa ?? '', date: win.date }
    }

    const started = await dispatchMacRun(version, tagSha, { gh, sleep, log })
    if (!started.id) return t.failAll(version, started.reason)
    t.runId = started.id
    return await collectMacRun(version, started.id, { ...deps, notes }, t)
  } catch (err) {
    return t.failAll(version, err.message)
  }
}

/** The run's end: each arch's artifact checked and signed, zips up, then manifests (may throw: callers catch) */
async function collectMacRun(version, id, deps, t) {
  const { run, fs = nodeFs, sign = signManifest, publicKey, log = console, root, notes } = deps
  const tag = `v${version}`
  const out = join(root, 'release', 'mac', version)
  const gh = (args, opts) => run('gh', args, opts)
  const { released, failed, zipsUploaded, manifestsRemoved } = t
  const failAll = (reason) => t.failAll(version, reason)

  // A failed job is looked at per arch below: the other arch may be fine. Started early,
  // the run is often done by now and the watch returns at once
  try { await gh(['run', 'watch', id, '--repo', REPO, '--exit-status'], { show: true }) } catch { log.warn(`Mac: CI run ${id} did not fully pass; checking each arch`) }
  let jobs = []
  try { jobs = JSON.parse(String(await gh(['run', 'view', id, '--repo', REPO, '--json', 'jobs']))).jobs ?? [] } catch {}

  const ready = []
  for (const arch of MAC_ARCHES) {
    const { artifact } = macArtifactNames(version, arch)
    const dir = join(out, artifact)
    try {
      const job = jobs.find(j => j.name === artifact)
      if (!job || job.conclusion !== 'success') {
        const failedSteps = (job?.steps ?? []).filter(st => st.conclusion === 'failure').map(st => st.name)
        throw new Error(`CI job ${artifact} ended ${job ? job.conclusion || job.status : 'missing'}${failedSteps.length ? ` (failed: ${failedSteps.join(', ')})` : ''}`)
      }
      try { await gh(['run', 'download', id, '--repo', REPO, '-n', artifact, '-D', dir], { show: true }) } catch (err) { throw new Error(`could not download ${artifact}: ${err.message}`) }
      const built = checkArch({ fs, dir, version, arch })
      const { file } = writeManifest('darwin', arch, {
        version, electron: built.electron, notes: notes.notes, notesEn: notes.notesEn, notesJa: notes.notesJa, date: notes.date,
        app: { file: built.app.file, sha256: built.app.sha256, size: built.app.size },
        full: { file: built.full.file, size: built.full.size },
      }, { dir: out, sign })
      const written = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!verifyManifest(written, publicKey)) {
        fs.rmSync(file, { force: true })
        return failAll(`${manifestName('darwin', arch)} does not verify with the key installed apps hold: is ${signingKeyPath()} the release key?`)
      }
      ready.push({ arch, zips: [built.app.path, built.full.path], manifest: file })
    } catch (err) {
      failed.push({ arch, reason: err.message })
      log.error(`Mac ${arch}: ${err.message}`)
    }
  }
  if (!ready.length) return t.result()

  // A retry rebuilds the zips and ditto's are not byte for byte the same: a manifest
  // already on the release would name a zip with another sha256 once it is replaced.
  // It goes first (no manifest only means no update offered); if it cannot go, nothing is replaced.
  let assets = []
  try { assets = (JSON.parse(String(await gh(['release', 'view', tag, '--repo', REPO, '--json', 'assets']))).assets ?? []).map(a => a.name) } catch (err) {
    return failAll(`could not list ${tag}'s assets: ${err.message}`)
  }
  for (const r of ready) {
    const name = manifestName('darwin', r.arch)
    if (!assets.includes(name)) continue
    try { await gh(['release', 'delete-asset', tag, name, '--repo', REPO, '--yes']) } catch (err) {
      return failAll(`could not remove the old ${name} before replacing its zips: ${err.message}`)
    }
    manifestsRemoved.push(r.arch)
  }

  // Zips first, manifests last: a manifest must never name a zip that is not there yet
  try { await gh(['release', 'upload', tag, '--repo', REPO, '--clobber', ...ready.flatMap(r => r.zips)], { show: true }) } catch (err) {
    return failAll(`the zip upload failed, so no manifest went up: ${err.message}`)
  }
  zipsUploaded.push(...ready.map(r => r.arch))
  try { await gh(['release', 'upload', tag, '--repo', REPO, '--clobber', ...ready.map(r => r.manifest)], { show: true }) } catch (err) {
    return failAll(`zips uploaded, manifests not: ${err.message}`)
  }
  for (const r of ready) released.push(r.arch)
  log.log(`Mac: released ${released.join(', ')} to ${tag}`)
  return t.result()
}

/** What to tell the operator when the Mac part did not fully go out */
export function macFailureMessage(version, { released = [], failed = [], zipsUploaded = [], manifestsRemoved = [] }, { windowsOut }) {
  const bar = '!'.repeat(72)
  const zipsOnly = zipsUploaded.filter(a => !released.includes(a))
  const removedOnly = manifestsRemoved.filter(a => !released.includes(a) && !zipsUploaded.includes(a))
  const state = []
  if (released.length) state.push(`  Released for: ${released.join(', ')}`)
  if (zipsOnly.length) state.push(`  Zips uploaded for ${zipsOnly.join(', ')}, manifests not: those Macs are offered no update until the retry.`)
  if (removedOnly.length) state.push(`  The old manifest of ${removedOnly.join(', ')} was removed, its zips not replaced: those Macs are offered no update until the retry.`)
  if (!state.length) state.push('  Nothing was uploaded for the Macs.')
  return [
    bar,
    `  The Mac release of ${version} did not fully go out.`,
    ...failed.map(f => `  - ${f.arch}: ${f.reason}`),
    ...state,
    windowsOut ? `  The Windows release v${version} is out and stays as it is.` : `  The Windows release v${version} was not touched.`,
    `  Retry the Mac part: node scripts/release.mjs --mac-only ${version}`,
    bar,
  ].join('\n')
}

/**
 * release.mjs's call: the Mac part with the real gh, git, key and file system.
 * Returns the exit code (0 when every arch went out). With `started` (what
 * startMacEarly returned before the Windows build), the run already going is
 * waited for instead of starting one.
 */
export async function runMacRelease({ root, version, notes = null, windowsOut, started = undefined }) {
  console.log(`\n== spawn ${version} for Mac`)
  if (!nodeFs.existsSync(signingKeyPath())) {
    console.error(macFailureMessage(version, { failed: [{ arch: 'all', reason: `no signing key at ${signingKeyPath()}` }] }, { windowsOut }))
    return 1
  }
  const run = realRun(root)
  const result = started === undefined
    ? await releaseMac(version, { run, root, notes })
    : await finishMacRelease(version, started, { run, root, notes })
  if (result.runId) console.log(`\n${macScreensHint(result.runId)}`)
  if (result.ok) return 0
  console.error(`\n${macFailureMessage(version, result, { windowsOut })}\n`)
  return 1
}

/** gh with its stdout captured (or shown) and its stderr shown */
function realRun(root) {
  return async (cmd, args, { show = false } = {}) => {
    const stdout = execFileSync(cmd, args, { cwd: root, encoding: 'utf8', shell: false, stdio: ['ignore', show ? 'inherit' : 'pipe', 'inherit'] })
    return (stdout ?? '').trim()
  }
}

/**
 * release.mjs --publish --with-mac, right after its preflight: v<version> pushed to
 * GitHub at `head` (the commit preflight found on origin/main; kept as it is when an
 * earlier attempt left it there), then the Mac build started on it, so CI runs while
 * Windows builds here. Nothing is released by this: a bare tag is no release, and the
 * in-app updater reads only releases (releases/latest/download/latest*.json). Resolves
 * to { id } or { reason }; never throws: a Mac start that fails leaves the Windows
 * release to go on, and the failure is reported at the end with the retry.
 */
export async function startMacEarly({ root, version, head, run = realRun(root), log = console, sleep = defaultSleep }) {
  const gh = (args, opts) => run('gh', args, opts)
  const tagSha = await tagShaOf(version, gh)
  if (tagSha && tagSha.toLowerCase() !== String(head).toLowerCase()) return { reason: `v${version} is at ${tagSha.slice(0, 7)}, not ${String(head).slice(0, 7)}` }
  if (!tagSha) {
    try { await gh(['api', `repos/${REPO}/git/refs`, '-f', `ref=refs/tags/v${version}`, '-f', `sha=${head}`, '--silent']) } catch (err) {
      return { reason: `could not push the tag v${version}: ${err.message}` }
    }
    log.log(`Mac: tag v${version} pushed at ${String(head).slice(0, 7)} (no release yet; should this run stop before making one, run it again: the tag is reused)`)
  }
  const started = await startMacBuild(version, { run, log, sleep })
  if (started.id) log.log(`Mac: building on CI while Windows builds here (${macRunUrl(started.id)})`)
  else log.warn(`Mac: the build did not start (${started.reason}); Windows goes on, the Mac part is reported at the end`)
  return started
}
