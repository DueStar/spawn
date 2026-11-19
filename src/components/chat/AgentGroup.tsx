/**
 * A sub-agent in the chat view (the lab's nested `.tl-group`): the Agent call's row —
 * 보조 에이전트, what it was asked to do, how many tools it used and its state — that
 * opens onto the sub-agent's own rows. Its rows live in the sub-agent's transcript; an open
 * row asks the lens for them (chat:agent) whenever it has none (also after main let them go:
 * a minute away, 다시 읽기) and again when the sub-agent moved on (its state or tool count
 * changed), one request at a time. They arrive as items with `parent` set to this row
 * (src/chat/rows.ts nests them here). A sub-agent waiting on the user says so on this row. 열어 보기 opens the
 * same rows, live, in the sub-agent panel beside the chat (AgentPanel.tsx).
 */

import React, { useEffect, useMemo, useState } from 'react'
import { t } from '../../i18n'
import { parseMarkdown } from '../../chat/markdown'
import { onChatForget } from '../../chat/lensMode'
import { toolLabel, toolMeta } from '../../chat/toolLabel'
import { initialOpen } from '../../chat/density'
import type { TextItem, ToolItem } from '../../chat/types'
import { AgentIcon, ChevIcon } from './ChatIcons'
import { useChatContext, useRowOpen } from './context'
import { Markdown } from './Markdown'
import { Meta, ToTerminal, ToolEntry } from './ToolRow'

/**
 * Requests in flight, and what each row last asked at (terminal:row → the sub-agent's moment, state:tools,
 * and whether its rows have been seen since: rows that went away again — main let them go — ask anew)
 */
const inFlight = new Set<string>()
export interface Asked { moment: string; rowsSeen: boolean }
const askedAt = new Map<string, Asked>()
onChatForget(id => { for (const k of [...askedAt.keys()]) if (k.startsWith(`${id}:`)) askedAt.delete(k) })

/**
 * Should an open Agent row ask for its rows now? (pure: tests/chat-rereview.test.ts) Once per moment of
 * the sub-agent (its state and tool count) — never again only because the answer's rows arrived — and
 * again when rows it had seen went away.
 */
export function shouldAskAgent(o: { open: boolean; inFlight: boolean; hasRows: boolean; asked: Asked | undefined; moment: string }): boolean {
  if (!o.open || o.inFlight) return false
  if (!o.asked || o.asked.moment !== o.moment) return true
  return !o.hasRows && o.asked.rowsSeen
}

const SubText: React.FC<{ item: TextItem }> = ({ item }) => {
  const { onLink, onPath } = useChatContext()
  const blocks = useMemo(() => parseMarkdown(item.text), [item.text])
  return (
    <div className="chat-sub-result">
      <span className="chat-sub-label">{t('결과')}</span>
      <div className="chat-prose"><Markdown blocks={blocks} onLink={onLink} onPath={onPath} /></div>
    </div>
  )
}

export const AgentGroup: React.FC<{ item: ToolItem; children: (ToolItem | TextItem)[] }> = ({ item, children }) => {
  const ctx = useChatContext()
  // (전부 opens it until the user closes it; open, it asks for its rows as a click would)
  const [open, setOpen] = useRowOpen(item.id, initialOpen(ctx.density ?? 'default', 'agent'))
  const lab = toolLabel(item)
  const waits = ctx.waitingAgents.includes(item.id)
  const meta = waits ? (ctx.cardHere ? { text: '아래 카드에서 답해 주세요', dot: 'amber' as const, terminal: false } : { text: '터미널에서 답해 주세요', dot: 'amber' as const, terminal: true }) : toolMeta(item)
  const tools = item.agentTools ?? children.filter(c => c.kind === 'tool').length
  const failed = item.state === 'failed'
  const key = `${ctx.id}:${item.id}`
  // the moment the rows are asked at: a new one when the sub-agent moved on
  const moment = `${item.state}:${item.agentTools ?? 0}`
  const hasRows = children.length > 0
  // a request that settled: the effect looks once more (the sub-agent may have moved on meanwhile)
  const [settled, setSettled] = useState(0)
  useEffect(() => {
    const asked = askedAt.get(key)
    if (asked && hasRows) asked.rowsSeen = true
    if (!shouldAskAgent({ open, inFlight: inFlight.has(key), hasRows, asked, moment })) return
    askedAt.set(key, { moment, rowsSeen: false })
    inFlight.add(key)
    ctx.loadAgent(item.id).catch(() => ({ ok: false })).finally(() => { inFlight.delete(key); setSettled(n => n + 1) })
  }, [open, key, moment, hasRows, settled]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`chat-tool chat-agent${failed ? ' fail' : ''}${waits ? ' wait' : ''}${open ? ' open' : ''}`} data-tool={item.id}>
      <div className="chat-tool-head">
        <button type="button" className="chat-tool-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="chat-tool-chev" aria-hidden="true"><ChevIcon /></span>
          <span className="chat-tool-ico"><AgentIcon /></span>
          <span className="chat-tool-label">{t(lab.label)}</span>
          {lab.detail && <span className="chat-tool-detail" title={lab.detail}>{lab.detail}</span>}
        </button>
        <Meta meta={meta} extra={tools > 0 ? t('도구 {n}개', { n: tools }) : null} />
        {waits && <ToTerminal />}
        {/* its whole conversation, live, in the panel beside the chat (src/components/chat/AgentPanel.tsx) */}
        {ctx.openAgent && (item.agentId || hasRows) && (
          <button type="button" className={`chat-btn chat-ag-open${ctx.agentShown === item.id ? ' on' : ''}`} aria-pressed={ctx.agentShown === item.id}
            title={t('이 보조 에이전트의 작업을 옆에서 보기')} onClick={() => ctx.openAgent!(item.id)}>{t('열어 보기')}</button>
        )}
      </div>
      {open && (
        <div className="chat-tool-body chat-agent-body">
          {children.map(c => (c.kind === 'tool' ? <ToolEntry key={c.id} item={c} /> : <SubText key={c.id} item={c} />))}
        </div>
      )}
    </div>
  )
}

export default AgentGroup
