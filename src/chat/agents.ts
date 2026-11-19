/**
 * The sub-agents at work, as the chat shows them (the strip of 일하는 보조 에이전트 above the composer, and the
 * sub-agent panel beside the conversation). Pure: tests/chat-agents.test.ts.
 *
 * Main says which sub-agents run (status.agents, from the hooks: electron/chatLens.cjs syncAgents); the page pairs
 * each with its Agent row when it has one (its description, its rows for the panel). A sub-agent known to run in the
 * foreground whose Agent row has ended is over, whatever the status still says (a SubagentStop that never came).
 */

import type { ChatItem, LensStatus, RunningAgent, TextItem, ToolInput, ToolItem } from './types'

const AGENT_TOOLS = new Set(['Agent', 'Task'])

export interface AgentChip {
  /** the agent id */
  id: string
  /** its Agent row (the panel opens on it); null: not known yet */
  toolId: string | null
  /** what it was asked (empty: the chip says 보조 에이전트) */
  title: string
  type: string | null
  since: number
  tools: number
  background: boolean
  last: { tool: string; input: ToolInput } | null
}

const isAgentRow = (i: ChatItem): i is ToolItem => i.kind === 'tool' && !i.parent && AGENT_TOOLS.has(i.tool ?? '')

/** The Agent row of a running sub-agent: its call's id, else the row that carries its agent id */
export function agentRowOf(a: Pick<RunningAgent, 'id' | 'toolId'>, items: ChatItem[]): ToolItem | null {
  let byId: ToolItem | null = null
  for (const i of items) {
    if (!isAgentRow(i)) continue
    if (a.toolId && i.id === a.toolId) return i
    if (!byId && i.agentId === a.id) byId = i
  }
  return byId
}

/** The chips, oldest first: status.agents paired with their rows; a foreground one whose row ended is left out */
export function runningAgents(status: Pick<LensStatus, 'agents'> | null, items: ChatItem[]): AgentChip[] {
  const list = status?.agents
  if (!list?.length) return []
  const out: AgentChip[] = []
  for (const a of list) {
    const row = agentRowOf(a, items)
    const background = a.background === true || row?.input.background === true
    // (only one known to run in the foreground: a background call's row is done at once while its agent works on)
    if (row && a.background === false && !background && row.state !== 'running' && row.state !== 'unknown') continue
    out.push({
      id: a.id,
      toolId: a.toolId ?? row?.id ?? null,
      title: (a.description ?? row?.input.description ?? '').trim(),
      type: a.type ?? row?.input.agentType ?? null,
      since: a.since,
      tools: Math.max(a.tools, row?.agentTools ?? 0),
      background,
      last: a.last ?? null,
    })
  }
  return out
}

/** A chip as drawn: `gone` is when it left the list (it says 끝남 a moment, then goes) */
export interface ShownChip extends AgentChip { gone?: number }

/** How long a finished chip stays (its 끝남, then its leave) */
export const CHIP_KEEP_MS = 1600

/**
 * The chips to draw: the running ones in their order, and the ones that just left, each where it was, until
 * CHIP_KEEP_MS after it went. A chip that comes back (the same id) is running again.
 */
export function presence(prev: ShownChip[], next: AgentChip[], now: number, keepMs = CHIP_KEEP_MS): ShownChip[] {
  const live = new Map(next.map(c => [c.id, c]))
  const out: ShownChip[] = []
  // (each chip keeps its place: nothing shifts under the pointer; a new one joins at the end, as the newest)
  for (const p of prev) {
    const n = live.get(p.id)
    if (n) { out.push(n); live.delete(p.id); continue }
    const gone = p.gone ?? now
    if (now - gone < keepMs) out.push(p.gone === undefined ? { ...p, gone } : p)
  }
  for (const c of next) if (live.has(c.id)) out.push(c)
  return out
}

/** Whether two chip lists draw the same (a timer tick that changes nothing keeps the old list) */
export function sameChips(a: ShownChip[], b: ShownChip[]): boolean {
  return a.length === b.length && a.every((x, i) => {
    const y = b[i]
    return x.id === y.id && x.gone === y.gone && x.tools === y.tools && x.title === y.title && x.toolId === y.toolId && x.last === y.last && x.since === y.since
  })
}

export type PanelRow =
  | { kind: 'tool'; item: ToolItem }
  | { kind: 'text'; item: TextItem }

/** The sub-agent panel's rows: the items under its Agent row (`parent`), in order — its tool calls and its text */
export function panelRows(items: ChatItem[], toolId: string): PanelRow[] {
  const out: PanelRow[] = []
  for (const i of items) {
    if (i.parent !== toolId) continue
    if (i.kind === 'tool') out.push({ kind: 'tool', item: i })
    else if (i.kind === 'text' && i.text.trim()) out.push({ kind: 'text', item: i })
  }
  return out
}

/**
 * The moment the panel's rows are asked at (as AgentGroup's): a new one whenever the sub-agent moved on — its row's
 * state or tool count, or the status's count while it runs
 */
export function panelMoment(row: ToolItem | null, chip: AgentChip | null): string {
  return `${row?.state ?? '-'}:${row?.agentTools ?? 0}:${chip ? chip.tools : 'x'}`
}
