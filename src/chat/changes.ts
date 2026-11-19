/**
 * The 변경 사항 panel's data: what the worker's change index answers (chat:changes, chat:change-file),
 * the file tree it is shown as, the unchanged lines between two hunks of one edit, and the file selected per
 * terminal (in memory, let go with the terminal: onChatForget).
 *
 * Nothing here composes edits or reads a file of the project: every line the panel draws is one
 * chat:change-file sent, rebuilt by the worker from the transcript line that recorded it.
 */

import { useEffect, useRef, useState } from 'react'
import { bridge } from '../desktop'
import { onChatForget } from './lensMode'
import { useChat } from './store'
import type { ChangeEdit, ChangeFile, ChangeSummary, DiffHunk } from './types'

// ---------------------------------------------------------------- the tree

export type TreeNode =
  | { kind: 'dir'; key: string; name: string; children: TreeNode[]; outside?: boolean }
  | { kind: 'file'; key: string; name: string; file: ChangeFile }

/** The group of the files outside the session folder (a Korean key, said through t()) */
export const OUTSIDE = '세션 폴더 밖'

const byName = (a: string, b: string) => {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0
}

interface Folder { dirs: Map<string, Folder>; files: { name: string; file: ChangeFile }[] }
const folder = (): Folder => ({ dirs: new Map(), files: [] })

/**
 * Folders first, then files, each alphabetical; a folder whose only child is a folder is joined with it
 * (`src/app/account`); the files outside the session folder last, in one group, by their whole path
 */
export function fileTree(files: ChangeFile[]): TreeNode[] {
  const root = folder()
  const outside: ChangeFile[] = []
  for (const f of files) {
    if (f.outside) { outside.push(f); continue }
    const parts = f.file.split('/').filter(Boolean)
    if (!parts.length) continue
    let at = root
    for (const p of parts.slice(0, -1)) {
      let next = at.dirs.get(p)
      if (!next) { next = folder(); at.dirs.set(p, next) }
      at = next
    }
    at.files.push({ name: parts[parts.length - 1], file: f })
  }
  const build = (at: Folder, path: string): TreeNode[] => {
    const dirs = [...at.dirs.entries()].sort((a, b) => byName(a[0], b[0])).map(([name, d]): TreeNode => {
      let label = name
      let full = path ? `${path}/${name}` : name
      while (d.dirs.size === 1 && d.files.length === 0) {
        const [sub, inner] = d.dirs.entries().next().value as [string, Folder]
        label = `${label}/${sub}`
        full = `${full}/${sub}`
        d = inner
      }
      return { kind: 'dir', key: `d:${full}`, name: label, children: build(d, full) }
    })
    const own = [...at.files].sort((a, b) => byName(a.name, b.name)).map(({ name, file }): TreeNode => ({ kind: 'file', key: `f:${file.file}`, name, file }))
    return [...dirs, ...own]
  }
  const tree = build(root, '')
  if (outside.length) {
    tree.push({
      kind: 'dir', key: 'outside', name: OUTSIDE, outside: true,
      children: [...outside].sort((a, b) => byName(a.file, b.file)).map(f => ({ kind: 'file', key: `f:${f.file}`, name: f.file, file: f })),
    })
  }
  return tree
}

/** One row of the tree as shown (folders closed hide their rows) */
export interface TreeRow { node: TreeNode; depth: number; parent: string | null }

export function visibleRows(tree: TreeNode[], closed: ReadonlySet<string>): TreeRow[] {
  const out: TreeRow[] = []
  const walk = (nodes: TreeNode[], depth: number, parent: string | null) => {
    for (const node of nodes) {
      out.push({ node, depth, parent })
      if (node.kind === 'dir' && !closed.has(node.key)) walk(node.children, depth + 1, node.key)
    }
  }
  walk(tree, 0, null)
  return out
}

/** Two names of one file (the page's diff block and the index may differ in slashes; Windows in case) */
export const fileKey = (file: string) => file.replace(/\\/g, '/').toLowerCase()

// ---------------------------------------------------------------- between two hunks of one edit

const oldLines = (h: DiffHunk) => h.lines.filter(l => l.t !== '+').length

/**
 * How many lines stay unchanged between two hunks of the same edit, from their own starts (a hunk with no
 * old lines sits after its start line); null when the hunks do not say it (never a guess, never negative)
 */
export function unchangedBetween(a: DiffHunk, b: DiffHunk): number | null {
  const na = oldLines(a)
  const nb = oldLines(b)
  const end = na ? a.oldStart + na - 1 : a.oldStart
  const start = nb ? b.oldStart : b.oldStart + 1
  const gap = start - end - 1
  return Number.isFinite(gap) && gap >= 0 ? gap : null
}

// ---------------------------------------------------------------- the file selected, per terminal

const selected = new Map<string, string>()
onChatForget(id => selected.delete(id))

export const selectedFile = (id: string): string | null => selected.get(id) ?? null
export function selectFile(id: string, file: string): void {
  selected.delete(id)
  selected.set(id, file)
  if (selected.size > 64) selected.delete(selected.keys().next().value as string)
}

// ---------------------------------------------------------------- what the worker answers

export interface ChangesList { summary: ChangeSummary; files: ChangeFile[]; agentsUnread: number }
export interface ChangesPage { file: ChangeFile; edits: ChangeEdit[]; more: number }

/** The summary the lens's status carries (null: no index for this view yet) */
export function useChangeSummary(id: string | null): ChangeSummary | null {
  return useChat(id).status?.changes ?? null
}

/** Debounce for a call caused by a new summary (the first call of a panel goes at once) */
export const CHANGES_DEBOUNCE_MS = 300

/**
 * chat:changes, while the panel is open: when it opens and again when status.changes.v changes (after
 * 300 ms, so a burst of edits asks once); never while closed. `failed`: the worker could not answer.
 */
export function useChanges(id: string, open: boolean): { list: ChangesList | null; failed: boolean } {
  const v = useChangeSummary(id)?.v ?? 0
  const [got, setGot] = useState<{ id: string; list: ChangesList | null; failed: boolean }>({ id, list: null, failed: false })
  const asked = useRef<string | null>(null)
  useEffect(() => {
    if (!open) { asked.current = null; return }
    let live = true
    const first = asked.current !== id
    asked.current = id
    const timer = setTimeout(() => {
      const p = bridge?.chat.changes?.(id)
      if (!p) return
      p.then(r => {
        if (!live) return
        if (r && r.ok) setGot({ id, list: { summary: r.summary, files: r.files, agentsUnread: r.agentsUnread }, failed: false })
        else setGot(cur => ({ id, list: cur.id === id ? cur.list : null, failed: true }))
      }, () => { if (live) setGot(cur => ({ id, list: cur.id === id ? cur.list : null, failed: true })) })
    }, first ? 0 : CHANGES_DEBOUNCE_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [id, open, v])
  return got.id === id ? { list: got.list, failed: got.failed } : { list: null, failed: false }
}

/**
 * chat:change-file for the selected file: its newest edits (each with its diff, rebuilt from its line), again
 * when status.changes.v changes (300 ms). Older pages are the panel's (`loadBefore`).
 */
export function useChangeFile(id: string, file: string | null, v: number): { page: ChangesPage | null; missing: boolean; key: string } {
  const key = `${id}\n${file ?? ''}`
  const [got, setGot] = useState<{ key: string; page: ChangesPage | null; missing: boolean }>({ key, page: null, missing: false })
  const asked = useRef<string | null>(null)
  useEffect(() => {
    if (!file) return
    let live = true
    const first = asked.current !== key
    asked.current = key
    const timer = setTimeout(() => {
      const p = bridge?.chat.changeFile?.({ id, file })
      if (!p) return
      p.then(r => {
        if (!live) return
        if (r && r.ok) setGot({ key, page: { file: r.file, edits: r.edits, more: r.more }, missing: false })
        else setGot({ key, page: null, missing: true })
      }, () => { if (live) setGot({ key, page: null, missing: true }) })
    }, first ? 0 : CHANGES_DEBOUNCE_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [id, file, v, key])
  return got.key === key ? { page: got.page, missing: got.missing, key } : { page: null, missing: false, key }
}

/** The edits before `before` (an order), for 이전 수정 더 보기 and for one edit sent without its diff */
export function loadBefore(id: string, file: string, before: number): Promise<ChangesPage | null> {
  const p = bridge?.chat.changeFile?.({ id, file, before })
  if (!p) return Promise.resolve(null)
  return p.then(r => (r && r.ok ? { file: r.file, edits: r.edits, more: r.more } : null), () => null)
}
