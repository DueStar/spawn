/**
 * 변경 사항 (the chat view, Phase 5; the lab's `.changes`, app.css 417–440, app.js 490–501): every file this
 * conversation changed, as a tree with +N −N, and the selected file's edits, one section per edit, in the
 * order they were made. It sits at the right of the chat's own area (Widget.tsx), only while the chat is
 * shown; the terminal's box never changes because of it.
 *
 * Wrong information is the worst failure, so it shows only what chat:change-file answers: each edit's
 * diff rebuilt by the worker from the transcript line that recorded it (electron/chatChanges.cjs). Edits
 * are never merged into one diff (that would need the file's contents between them, which the record does
 * not hold): "⋯ {n}줄 그대로" is said only between two hunks of the same edit. A patch the record does not
 * hold, one cut by a cap and one whose line changed since are said, never drawn as empty. Totals are sums
 * of edits and say so. Files changed by commands are not in the record: the foot says so, always.
 *
 * Also the header's button (the lab's `.chg`): the panel icon and the conversation's +N −N.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import '../../styles/chat.css'
import { locale, t } from '../../i18n'
import { CH_MIN, clampChangesWidth } from '../../changesWidth'
import { fileKey, fileTree, loadBefore, selectFile, selectedFile, unchangedBetween, useChangeFile, useChangeSummary, useChanges, visibleRows, OUTSIDE, type TreeNode } from '../../chat/changes'
import { openFileFromChat } from '../../chat/lensMode'
import { isRemotePath } from '../../chat/markdown'
import { chatStore } from '../../chat/store'
import type { ChangeEdit, ChangeFile, DiffBlock } from '../../chat/types'
import { ChevIcon, XIcon } from './ChatIcons'

const svg = (size: number, body: React.ReactNode) => (
  <svg className="ico" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{body}</svg>
)
/** A window with a panel on its right (the lab's panelR) */
export const PanelRightIcon = ({ size = 14 }: { size?: number }) => svg(size, <><rect x="2.5" y="3" width="11" height="10" rx="2" /><path d="M9.5 3v10" /></>)

const clock = (at: number) => new Date(at).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' })

/** +N −N in the chat's colours (a zero quiet) */
const Counts: React.FC<{ added: number; removed: number; title?: string; className?: string }> = ({ added, removed, title, className }) => (
  <span className={`chat-counts${className ? ` ${className}` : ''}`} title={title}>
    <span className={added ? 'a' : 'z'}>+{added}</span>
    <span className={removed ? 'd' : 'z'}>−{removed}</span>
  </span>
)

// ---------------------------------------------------------------- the header's button

/**
 * 변경 사항 in the session header (only while the chat is shown): the panel icon, and the conversation's
 * +N −N once the index has gathered some (the icon alone while it gathers or with no edit); pressed while
 * the panel is open; in a window too narrow for the panel, it says so and opens nothing.
 */
export const ChangesButton: React.FC<{ id: string; open: boolean; enabled: boolean; onToggle(): void }> = ({ id, open, enabled, onToggle }) => {
  const s = useChangeSummary(id)
  const known = s ? s.edits - s.unknown : 0
  const counts = !!s && s.state !== 'scanning' && known > 0
  const name = counts ? `${t('변경 사항')} +${s!.added} −${s!.removed}` : t('변경 사항')
  const pressed = open && enabled
  return (
    <button
      type="button"
      className={`w-chg${pressed ? ' on' : ''}`}
      aria-pressed={pressed}
      aria-disabled={enabled ? undefined : true}
      aria-label={name}
      title={enabled ? (counts ? `${t('변경 사항')} · ${t('수정 {n}번의 줄 수를 더한 값이에요', { n: known })}` : t('변경 사항')) : t('창이 좁아서 변경 사항을 열 수 없어요')}
      onClick={() => { if (enabled) onToggle() }}
    >
      <PanelRightIcon size={14} />
      {counts && (
        <span className="w-chg-counts" aria-hidden="true">
          <span className={s!.added ? 'a' : 'z'}>+{s!.added}</span>
          <span className={s!.removed ? 'd' : 'z'}>−{s!.removed}</span>
        </span>
      )}
    </button>
  )
}

// ---------------------------------------------------------------- one edit

/**
 * One edit, on its own (never composed with another): a quiet head (수정 n · time · what it was · +a −r),
 * then its hunks as recorded, the unchanged lines between two of them counted from their own starts; or
 * the words for an edit whose patch is not in the record, one whose line changed since, or one sent
 * without its diff (the answer's line budget) with a button to fetch it.
 */
export const EditSection: React.FC<{ edit: ChangeEdit; n: number; onReload(): void; onLoad(edit: ChangeEdit): void; loading?: boolean }> = ({ edit, n, onReload, onLoad, loading = false }) => {
  const diff: DiffBlock | undefined = edit.diff
  const words = [t('수정 {n}', { n })]
  if (edit.at !== null) words.push(clock(edit.at))
  if (edit.kind === 'create') words.push(t('새 파일'))
  if (edit.agentId) words.push(t('보조 에이전트의 수정'))
  const known = edit.state !== 'missing' && edit.added !== null && edit.removed !== null
  return (
    <section className="chat-ch-edit" data-tool={edit.toolId} aria-label={words.join(' · ')}>
      <div className="chat-ch-ehead">
        <span className="chat-ch-ewords">{words.join(' · ')}</span>
        {diff?.truncated && <span className="chat-ch-cut" title={t('줄이 너무 길어서 일부만 보여요. 전체는 터미널에서 보세요')}>{t('잘림')}</span>}
        {known && <Counts added={edit.added!} removed={edit.removed!} />}
      </div>
      {edit.state === 'missing' && <p className="chat-ch-note">{t('이 수정의 내용은 기록에 없어요 · 터미널에서 보세요')}</p>}
      {edit.state === 'stale' && (
        <p className="chat-ch-note">
          <span>{t('기록이 바뀌어서 이 수정을 다시 읽지 못했어요')}</span>
          <span aria-hidden="true"> · </span>
          <button type="button" className="chat-link-btn" onClick={onReload}>{t('다시 읽기')}</button>
        </p>
      )}
      {edit.state === 'ok' && !diff && (
        <p className="chat-ch-note">
          <button type="button" className="chat-link-btn" disabled={loading} onClick={() => onLoad(edit)}>{t('이 수정 보기')}</button>
        </p>
      )}
      {edit.state === 'ok' && diff && diff.hunks.length > 0 && (
        <div className="chat-ch-lines">
          {diff.hunks.map((h, i) => {
            const gap = i > 0 ? unchangedBetween(diff.hunks[i - 1], h) : null
            return (
              <React.Fragment key={i}>
                {i > 0 && gap !== 0 && <div className="chat-ch-gap">{gap === null ? '⋯' : t('⋯ {n}줄 그대로', { n: gap })}</div>}
                {h.lines.map((l, j) => (
                  <div key={j} className={`chat-dl${l.t === '+' ? ' add' : l.t === '-' ? ' del' : ''}`}>
                    <span className="no">{l.t === '-' ? l.old : l.new}</span>
                    <span className="sg">{l.t === ' ' ? '' : l.t === '-' ? '−' : '+'}</span>
                    <span className="tx">{l.text}</span>
                  </div>
                ))}
              </React.Fragment>
            )
          })}
        </div>
      )}
      {edit.state === 'ok' && diff && diff.hidden > 0 && <p className="chat-ch-note">{t('{n}줄은 터미널에서 보세요', { n: diff.hidden })}</p>}
    </section>
  )
}

// ---------------------------------------------------------------- the resize handle

/**
 * The panel's left edge (the left panel's SideResize, mirrored): drag it for 260–560px, the conversation
 * keeping 400; double-click or Home for the default; ← wider, → narrower, 16px at a time. While dragged
 * it sets the chat area's --ch-w itself (no re-render per move); the width is committed on release.
 */
const ChangesResize: React.FC<{ width: number; max: number; onWidth(px: number | null, save: boolean): void }> = ({ width, max, onWidth }) => {
  const right = useRef<number | null>(null)
  const body = useRef<HTMLElement | null>(null)
  const room = () => body.current?.clientWidth ?? window.innerWidth
  const at = (e: React.PointerEvent) => clampChangesWidth((right.current ?? 0) - e.clientX, room())
  const show = (px: number) => body.current?.style.setProperty('--ch-w', `${px}px`)
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    right.current = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().right
    body.current = e.currentTarget.closest('.w-term-body')
    body.current?.closest('.widget')?.classList.add('resizing')
  }
  const end = () => { right.current = null; body.current?.closest('.widget')?.classList.remove('resizing') }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (right.current === null) return
    const w = at(e)
    show(w)
    e.currentTarget.setAttribute('aria-valuenow', String(w))
  }
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (right.current === null) return
    const w = at(e)
    show(w)
    e.currentTarget.setAttribute('aria-valuenow', String(w))
    end()
    onWidth(w, true)
  }
  const onCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (right.current === null) return
    show(width)
    e.currentTarget.setAttribute('aria-valuenow', String(width))
    end()
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); onWidth(width + (e.key === 'ArrowLeft' ? 16 : -16), true) }
    else if (e.key === 'Home') { e.preventDefault(); onWidth(null, true) }
  }
  return (
    <div className="chat-ch-rz" role="separator" aria-orientation="vertical" tabIndex={0}
      aria-valuemin={CH_MIN} aria-valuemax={max} aria-valuenow={width}
      title={t('끌어서 폭 조절 · 두 번 누르면 기본')} aria-label={t('변경 사항 패널 폭')}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel} onLostPointerCapture={onCancel}
      onDoubleClick={() => onWidth(null, true)} onKeyDown={onKey} />
  )
}

// ---------------------------------------------------------------- the tree

const Tree: React.FC<{ tree: TreeNode[]; selected: string | null; onSelect(file: string): void }> = ({ tree, selected, onSelect }) => {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())
  const rows = useMemo(() => visibleRows(tree, closed), [tree, closed])
  const selKey = selected === null ? null : rows.find(r => r.node.kind === 'file' && fileKey(r.node.file.file) === fileKey(selected))?.node.key ?? null
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const current = rows.some(r => r.node.key === focusKey) ? focusKey : selKey ?? rows[0]?.node.key ?? null
  const els = useRef(new Map<string, HTMLElement>())
  const moved = useRef(false)
  useEffect(() => {
    if (!moved.current || !current) return
    moved.current = false
    els.current.get(current)?.focus()
  }, [current])
  const go = (key: string | null | undefined) => { if (!key) return; moved.current = true; setFocusKey(key) }
  const toggle = (key: string) => setClosed(c => { const n = new Set(c); if (n.has(key)) n.delete(key); else n.add(key); return n })
  const onKey = (e: React.KeyboardEvent) => {
    const i = rows.findIndex(r => r.node.key === current)
    if (i < 0) return
    const row = rows[i]
    const node = row.node
    const open = node.kind === 'dir' && !closed.has(node.key)
    switch (e.key) {
      case 'ArrowDown': go(rows[i + 1]?.node.key); break
      case 'ArrowUp': go(rows[i - 1]?.node.key); break
      case 'Home': go(rows[0]?.node.key); break
      case 'End': go(rows[rows.length - 1]?.node.key); break
      case 'ArrowRight':
        if (node.kind === 'dir') { if (!open) toggle(node.key); else go(rows[i + 1]?.node.key) }
        break
      case 'ArrowLeft':
        if (node.kind === 'dir' && open) toggle(node.key)
        else go(row.parent)
        break
      case 'Enter': case ' ':
        if (node.kind === 'file') onSelect(node.file.file)
        else toggle(node.key)
        break
      default: return
    }
    e.preventDefault()
  }
  // the position of each item among its siblings, for a screen reader
  const sizes = useMemo(() => {
    const m = new Map<string, { set: number; pos: number }>()
    const walk = (nodes: TreeNode[]) => nodes.forEach((n, i) => { m.set(n.key, { set: nodes.length, pos: i + 1 }); if (n.kind === 'dir') walk(n.children) })
    walk(tree)
    return m
  }, [tree])
  return (
    <div className="chat-ch-tree" role="tree" aria-label={t('파일 목록')} onKeyDown={onKey}>
      {rows.map(({ node, depth }) => {
        const pad = 8 + depth * 14
        const ref = (el: HTMLElement | null) => { if (el) els.current.set(node.key, el); else els.current.delete(node.key) }
        const pos = sizes.get(node.key)
        const common = {
          ref, role: 'treeitem', 'aria-level': depth + 1, 'aria-setsize': pos?.set, 'aria-posinset': pos?.pos,
          tabIndex: node.key === current ? 0 : -1,
          onFocus: () => setFocusKey(node.key),
        }
        if (node.kind === 'dir') {
          const open = !closed.has(node.key)
          return (
            <div key={node.key} {...common} className="chat-ch-tn dir" aria-expanded={open} aria-selected={false} style={{ paddingLeft: pad }} onClick={() => { setFocusKey(node.key); toggle(node.key) }}>
              <span className={`chat-ch-chev${open ? ' open' : ''}`} aria-hidden="true"><ChevIcon size={11} /></span>
              <span className="chat-ch-nm">{node.outside ? t(OUTSIDE) : node.name}</span>
            </div>
          )
        }
        const f = node.file
        const on = node.key === selKey
        return (
          <div key={node.key} {...common} className="chat-ch-tn file" aria-selected={on} style={{ paddingLeft: pad + 17 }} title={f.file}
            onClick={() => { setFocusKey(node.key); onSelect(f.file) }}>
            <span className="chat-ch-nm">{node.name}</span>
            {f.created && <span className="chat-ch-tag">{t('새 파일')}</span>}
            {f.unknown > 0 && <span className="chat-ch-tag">{t('일부 모름')}</span>}
            {f.edits > f.unknown && <Counts added={f.added} removed={f.removed} />}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- the panel

export interface ChangesTarget { file: string; toolId: string | null; n: number }

export interface ChangesPanelProps {
  /** The terminal (session) the conversation belongs to */
  id: string
  width: number
  /** The widest it may be in this window */
  max: number
  onWidth(px: number | null, save: boolean): void
  onClose(): void
  /** Open at this file (and scroll to this edit): a diff block's +N −N */
  target: ChangesTarget | null
}

export const ChangesPanel: React.FC<ChangesPanelProps> = ({ id, width, max, onWidth, onClose, target }) => {
  const status = useChangeSummary(id)
  const { list, failed } = useChanges(id, true)
  const summary = list?.summary ?? status
  const files = list?.files ?? null
  const tree = useMemo(() => (files ? fileTree(files) : []), [files])
  // the file shown: the one asked for (a diff chip), else the one chosen before in this session, else the latest changed
  const [chosen, setChosen] = useState<string | null>(() => target?.file ?? selectedFile(id))
  useEffect(() => { if (target) { setChosen(target.file); selectFile(id, target.file) } }, [target, id])
  const pick = useCallback((file: string) => { setChosen(file); selectFile(id, file) }, [id])
  const found = (name: string | null): ChangeFile | null => (name && files ? files.find(f => f.file === name) ?? files.find(f => fileKey(f.file) === fileKey(name)) ?? null : null)
  const current = found(chosen) ?? (files?.[0] ?? null)
  const name = current?.file ?? null
  const v = status?.v ?? 0
  const { page } = useChangeFile(id, name, v)
  // older pages (이전 수정 더 보기) and edits sent without their diff, fetched alone; both dropped with a new page
  const [older, setOlder] = useState<{ page: typeof page; edits: ChangeEdit[]; more: number } | null>(null)
  const [filled, setFilled] = useState<Map<string, DiffBlock>>(() => new Map())
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => { setOlder(null); setFilled(new Map()) }, [page])
  const edits: ChangeEdit[] = useMemo(() => {
    if (!page) return []
    const all = [...(older?.page === page ? older.edits : []), ...page.edits]
    return all.map(e => (e.state === 'ok' && !e.diff && filled.has(e.toolId) ? { ...e, diff: filled.get(e.toolId) } : e))
  }, [page, older, filled])
  const more = older?.page === page ? older.more : page?.more ?? 0
  const showOlder = () => {
    if (!page || !name || !edits.length || busy) return
    const p = page
    setBusy('older')
    loadBefore(id, name, edits[0].order).then(r => {
      setBusy(null)
      if (!r) return
      setOlder(cur => ({ page: p, edits: [...r.edits, ...(cur?.page === p ? cur.edits : [])], more: r.more }))
    })
  }
  const loadOne = (e: ChangeEdit) => {
    if (!name || busy) return
    const i = edits.findIndex(x => x.toolId === e.toolId)
    const next = edits[i + 1]
    if (!next) return
    setBusy(e.toolId)
    loadBefore(id, name, next.order).then(r => {
      setBusy(null)
      const got = r?.edits.find(x => x.toolId === e.toolId)
      if (got?.diff) setFilled(m => new Map(m).set(e.toolId, got.diff!))
    })
  }
  const reload = () => chatStore.reload(id)
  // a diff chip's edit: scrolled into view once its section is there
  const scroller = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const wanted = useRef<ChangesTarget | null>(null)
  const olderAsked = useRef<number | null>(null)
  useEffect(() => { wanted.current = target; olderAsked.current = null }, [target])
  useLayoutEffect(() => {
    const w = wanted.current
    const box = scroller.current
    if (!w?.toolId || !box || !current || fileKey(current.file) !== fileKey(w.file)) return
    const el = box.querySelector<HTMLElement>(`[data-tool="${CSS.escape(w.toolId)}"]`)
    if (!el) {
      // (an edit older than the newest page: the pages before it, one at a time, each asked once)
      if (page && more > 0 && !busy && edits.length && olderAsked.current !== edits[0].order) { olderAsked.current = edits[0].order; showOlder() }
      return
    }
    wanted.current = null
    box.scrollTop = Math.max(0, box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top - (head.current?.offsetHeight ?? 0))
  })
  const close = () => {
    const back = document.querySelector<HTMLElement>('.w-chg')
    onClose()
    if (back) requestAnimationFrame(() => { if (back.isConnected) back.focus() })
  }
  const known = summary ? summary.edits - summary.unknown : 0
  // (gathering: said only while the worker says so, or before its first answer; a failed answer claims nothing)
  const scanning = summary ? summary.state === 'scanning' : !failed
  const empty = !!files && files.length === 0 && !scanning
  const firstLine = (() => { for (let i = edits.length - 1; i >= 0; i--) { const h = edits[i].diff?.hunks[0]; if (h) return h.newStart || undefined } return undefined })()
  return (
    <aside className="chat-changes" aria-label={t('변경 사항')}>
      <ChangesResize width={width} max={max} onWidth={onWidth} />
      <div className="chat-ch-head">
        <b>{t('변경 사항')}</b>
        {summary && !scanning && known > 0 && <Counts added={summary.added} removed={summary.removed} title={t('수정 {n}번의 줄 수를 더한 값이에요', { n: known })} />}
        <span className="chat-ch-spacer" />
        <button type="button" className="chat-ch-x" onClick={close} title={t('변경 사항 닫기')} aria-label={t('변경 사항 닫기')}><XIcon size={12} /></button>
      </div>
      <div className="chat-ch-sub" role="status">
        {scanning ? <span>{t('변경 사항을 모으는 중…')}</span> : summary && !empty && <span>{t('파일 {n}개 · 수정 {m}번', { n: summary.files, m: summary.edits })}</span>}
        {summary?.state === 'partial' && <span className="chat-ch-partial">{t('기록이 너무 길어서 앞부분의 변경은 다 모으지 못했어요')}</span>}
      </div>
      {/* (the record deleted while the view was open: said, and nothing of it kept — Phase 6 drill) */}
      {empty && <p className="chat-ch-empty">{summary?.state === 'gone' ? t('세션 기록 파일을 찾지 못했어요') : t('이 대화에서 바뀐 파일이 아직 없어요')}</p>}
      {!empty && tree.length > 0 && <Tree tree={tree} selected={name} onSelect={pick} />}
      <div className="chat-ch-diff" ref={scroller}>
        {current && (
          <div className="chat-ch-dhead" ref={head}>
            <span className="chat-ch-fname" title={current.file}>{current.file}</span>
            {current.edits > current.unknown && <Counts added={current.added} removed={current.removed} title={t('수정 {n}번의 줄 수를 더한 값이에요', { n: current.edits - current.unknown })} />}
            {!isRemotePath(current.file) && (
              <button type="button" className="chat-ch-open" onClick={() => openFileFromChat(id, current.file, firstLine)}>{t('편집기에서 열기')}</button>
            )}
          </div>
        )}
        {current && page && more > 0 && (
          <button type="button" className="chat-ch-more" disabled={busy === 'older'} onClick={showOlder}>{t('이전 수정 {n}번 더 보기', { n: more })}</button>
        )}
        {current && page && edits.map((e, i) => (
          <EditSection key={e.toolId} edit={e} n={more + i + 1} onReload={reload} onLoad={loadOne} loading={busy === e.toolId} />
        ))}
      </div>
      <div className="chat-ch-foot">
        <p>{t('Edit·Write로 바꾼 것만 보여요. 명령으로 바꾼 파일은 터미널에서 확인해 주세요')}</p>
        {!!list && list.agentsUnread > 0 && <p>{t('보조 에이전트 {n}개의 변경은 읽지 못했어요', { n: list.agentsUnread })}</p>}
      </div>
    </aside>
  )
}

export default ChangesPanel
