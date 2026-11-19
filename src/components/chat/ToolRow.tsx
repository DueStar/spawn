/**
 * One tool call in the chat view: a single line — chevron, icon, label,
 * detail, and quiet words on the right — that opens to show its output. A failed call is
 * red and shows its first error line. A call that waits on the user (a permission, a
 * question, a plan) is never folded: an amber dot, "터미널에서 답해 주세요" and 터미널로
 * 보기 (answering from the chat is a later phase). A question shows its options and a plan
 * its text, always open. An edit with a diff draws as a DiffBlock, a sub-agent as an
 * AgentGroup (ToolEntry picks).
 */

import React, { useMemo } from 'react'
import { t } from '../../i18n'
import { parseMarkdown } from '../../chat/markdown'
import { toolLabel, toolMeta, type ToolMeta } from '../../chat/toolLabel'
import { initialOpen } from '../../chat/density'
import type { TextItem, ToolItem } from '../../chat/types'
import { ChevIcon, ToolGlyph } from './ChatIcons'
import { useChatContext, useRowOpen } from './context'
import { Markdown } from './Markdown'
import { DiffBlock } from './DiffBlock'
import { AgentGroup } from './AgentGroup'
import { FullButton } from './FullView'

/** The first line of a failed call's output, without Claude Code's error tags */
export function errorLine(item: ToolItem): string {
  const lines = (item.output?.text ?? '').replace(/<\/?tool_use_error>/g, '').split('\n').map(l => l.trim()).filter(l => l && !/^Exit code \d+$/.test(l))
  // the line that says what went wrong, else the first one
  const said = lines.find(l => /\b(error|failed|fatal|cannot|can't|not found|denied|refused|exception)\b/i.test(l))
  return (said ?? lines[0] ?? '').slice(0, 300)
}

/** The quiet words on the right, with their dot */
export const Meta: React.FC<{ meta: ToolMeta | null; extra?: string | null }> = ({ meta, extra }) => {
  if (!meta && !extra) return null
  return (
    <span className="chat-tool-meta">
      {meta?.dot && <i className={`chat-dot ${meta.dot}`} aria-hidden="true" />}
      {[extra, meta && t(meta.text, meta.vars)].filter(Boolean).join(' · ')}
    </span>
  )
}

/** 터미널로 보기, beside a call that waits on the user */
export const ToTerminal: React.FC = () => {
  const { onTerminal } = useChatContext()
  return <button type="button" className="chat-btn" onClick={onTerminal}>{t('터미널로 보기')}</button>
}

const ALWAYS_OPEN = new Set(['AskUserQuestion', 'ExitPlanMode'])

export const ToolRow: React.FC<{ item: ToolItem }> = ({ item }) => {
  const ctx = useChatContext()
  const lab = toolLabel(item)
  // (a card below answers it: the row points there, with no 터미널로 보기)
  const meta = item.waiting && ctx.cardHere ? { text: '아래 카드에서 답해 주세요', dot: 'amber' as const, terminal: false } : toolMeta(item)
  const failed = item.state === 'failed'
  const always = !!item.tool && ALWAYS_OPEN.has(item.tool)
  const out = item.output && item.output.text ? item.output : null
  const foldable = !always && !!out
  // (전부 opens it until the user closes it)
  const [open, setOpen] = useRowOpen(item.id, initialOpen(ctx.density ?? 'default', 'tool'))
  const err = failed ? errorLine(item) : ''
  const planBlocks = useMemo(() => (item.tool === 'ExitPlanMode' && item.input.plan ? parseMarkdown(item.input.plan) : null), [item.tool, item.input.plan])

  const label = t(lab.label, lab.vars)
  const inner = (
    <>
      <span className="chat-tool-chev" aria-hidden="true" style={foldable ? undefined : { visibility: 'hidden' }}><ChevIcon /></span>
      <span className="chat-tool-ico"><ToolGlyph icon={lab.icon} /></span>
      <span className="chat-tool-label">{label}</span>
      {lab.detail && !always && <span className={`chat-tool-detail${lab.mono ? ' mono' : ''}`} title={lab.detail}>{lab.detail}</span>}
      {err && <span className="chat-tool-err" title={err}>{err}</span>}
    </>
  )
  return (
    <div className={`chat-tool${failed ? ' fail' : ''}${item.waiting ? ' wait' : ''}${open && foldable ? ' open' : ''}`}>
      <div className="chat-tool-head">
        {foldable
          ? <button type="button" className="chat-tool-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{inner}</button>
          : <div className="chat-tool-toggle">{inner}</div>}
        <Meta meta={meta} />
        {meta?.terminal && <ToTerminal />}
        {/* a later phase puts "고쳐 달라고 하기" here, on a failed call */}
      </div>
      {item.tool === 'AskUserQuestion' && (
        <div className="chat-tool-body chat-ask">
          {item.input.question && <p className="chat-ask-q">{item.input.question}</p>}
          {!!item.input.options?.length && (
            <ol className="chat-ask-opts">{item.input.options.map((o, i) => <li key={i}>{o}</li>)}</ol>
          )}
        </div>
      )}
      {planBlocks && (
        <div className="chat-tool-body chat-plan chat-prose"><Markdown blocks={planBlocks} onLink={ctx.onLink} onPath={ctx.onPath} /></div>
      )}
      {foldable && open && out && (
        <div className="chat-tool-body">
          <pre className="chat-tool-out" tabIndex={0} aria-label={label}>{out.text}</pre>
          {out.truncated && <p className="chat-tool-note">{t('출력이 길어서 앞부분만 보여요 ({lines}줄)', { lines: out.lines })} <FullButton itemId={item.id} title={label} /></p>}
        </div>
      )}
    </div>
  )
}

/** A tool item as the chat draws it: a diff, a sub-agent group, or a plain row */
export const ToolEntry: React.FC<{ item: ToolItem; children?: (ToolItem | TextItem)[] }> = ({ item, children = [] }) => {
  if ((item.tool === 'Agent' || item.tool === 'Task') && !item.parent) return <AgentGroup item={item} children={children} />
  if (item.diff && item.state === 'done') return <DiffBlock item={item} diff={item.diff} />
  return <ToolRow item={item} />
}

export default ToolRow
