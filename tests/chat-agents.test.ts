/**
 * The sub-agents at work in the chat (src/chat/agents.ts, src/components/chat/AgentPanel.tsx agentWidth): the strip's
 * chips from status.agents and the Agent rows, a finished chip's moment before it leaves, the panel's rows and the
 * moment they are asked again at, and the panel's width beside the conversation.
 */

import { describe, expect, it } from 'vitest'
import { CHIP_KEEP_MS, panelMoment, panelRows, presence, runningAgents, sameChips, type AgentChip } from '../src/chat/agents'
import { AG_CONVO, AG_DEFAULT, AG_MAX, AG_MIN, agentWidth } from '../src/components/chat/AgentPanel'
import type { ChatItem, LensStatus, RunningAgent, ToolItem } from '../src/chat/types'

const agentRow = (id: string, extra: Partial<ToolItem> = {}): ToolItem => ({ id, order: 10, at: 1, kind: 'tool', tool: 'Agent', input: { description: `row ${id}`, agentType: 'Explore' }, state: 'running', ...extra })
const status = (agents: RunningAgent[]): Pick<LensStatus, 'agents'> => ({ agents })

describe('runningAgents: the strip\'s chips', () => {
  it('none without status.agents', () => {
    expect(runningAgents(null, [])).toEqual([])
    expect(runningAgents({}, [agentRow('t1')])).toEqual([])
  })

  it('a chip per running sub-agent, paired with its row by call id or agent id; the meta description first', () => {
    const items: ChatItem[] = [agentRow('t1'), agentRow('t2', { agentId: 'a2', agentTools: 7 })]
    const chips = runningAgents(status([
      { id: 'a1', since: 100, tools: 2, toolId: 't1', description: 'Find the bug' },
      { id: 'a2', since: 200, tools: 3 },
      { id: 'a3', since: 300, tools: 0, type: 'general-purpose' },
    ]), items)
    expect(chips.map(c => [c.id, c.toolId, c.title, c.tools])).toEqual([
      ['a1', 't1', 'Find the bug', 2],
      ['a2', 't2', 'row t2', 7],
      ['a3', null, '', 0],
    ])
    expect(chips[2].type).toBe('general-purpose')
  })

  it('a foreground one whose row ended is over (a SubagentStop that never came); a background one works on', () => {
    const items: ChatItem[] = [agentRow('t1', { state: 'done' }), agentRow('t2', { state: 'done', input: { description: 'bg', background: true } }), agentRow('t3', { state: 'done' })]
    const chips = runningAgents(status([
      { id: 'a1', since: 1, tools: 0, toolId: 't1', background: false },
      { id: 'a2', since: 2, tools: 0, toolId: 't2' },
      // (not known whether foreground: main decides, the chip stays)
      { id: 'a3', since: 3, tools: 0, toolId: 't3' },
    ]), items)
    expect(chips.map(c => c.id)).toEqual(['a2', 'a3'])
    expect(chips[0].background).toBe(true)
  })
})

const chip = (id: string, extra: Partial<AgentChip> = {}): AgentChip => ({ id, toolId: `t-${id}`, title: id, type: null, since: 0, tools: 0, background: false, last: null, ...extra })

describe('presence: the chips as drawn', () => {
  it('a finished chip stays where it was for CHIP_KEEP_MS (its 끝남), then goes; a new one joins at the end', () => {
    let shown = presence([], [chip('a'), chip('b')], 0)
    expect(shown.map(c => c.id)).toEqual(['a', 'b'])
    shown = presence(shown, [chip('b'), chip('c')], 1000)
    expect(shown.map(c => [c.id, c.gone])).toEqual([['a', 1000], ['b', undefined], ['c', undefined]])
    // (its time is kept: a later list does not restart it)
    shown = presence(shown, [chip('b'), chip('c')], 1000 + CHIP_KEEP_MS - 1)
    expect(shown.find(c => c.id === 'a')?.gone).toBe(1000)
    shown = presence(shown, [chip('b'), chip('c')], 1000 + CHIP_KEEP_MS)
    expect(shown.map(c => c.id)).toEqual(['b', 'c'])
  })

  it('a chip that comes back is running again; sameChips tells a list that draws the same', () => {
    let shown = presence([chip('a')], [], 5)
    expect(shown[0].gone).toBe(5)
    shown = presence(shown, [chip('a', { tools: 2 })], 6)
    expect(shown[0].gone).toBeUndefined()
    expect(shown[0].tools).toBe(2)
    expect(sameChips(shown, presence(shown, [shown[0]], 7))).toBe(true)
    expect(sameChips(shown, presence(shown, [chip('a', { tools: 3 })], 7))).toBe(false)
  })
})

describe('the panel', () => {
  it('panelRows: its tools and text, in order; nothing of other rows', () => {
    const items: ChatItem[] = [
      agentRow('t1'),
      { id: 'u1', order: 1, at: null, parent: 't1', kind: 'user', text: 'Count the lines', images: 0 },
      { id: 'x1', order: 2, at: null, parent: 't1', kind: 'tool', tool: 'Read', input: { file: 'a.ts' }, state: 'done' },
      { id: 'th', order: 3, at: null, parent: 't1', kind: 'thinking', text: '' },
      { id: 'u2', order: 4, at: null, parent: 't1', kind: 'user', text: 'again', images: 0 },
      { id: 'w1', order: 5, at: null, parent: 't1', kind: 'text', text: '3' },
      { id: 'w2', order: 6, at: null, parent: 't1', kind: 'text', text: '  ' },
      { id: 'o1', order: 7, at: null, parent: 't9', kind: 'text', text: 'not this one' },
      { id: 'm1', order: 8, at: null, kind: 'text', text: 'main' },
    ]
    expect(panelRows(items, 't1').map(r => [r.kind, r.item.id])).toEqual([['tool', 'x1'], ['text', 'w1']])
  })

  it('panelMoment changes whenever the sub-agent moved on (its row or the status count)', () => {
    const row = agentRow('t1', { agentTools: 2 })
    const a = panelMoment(row, chip('a', { tools: 2 }))
    expect(panelMoment(row, chip('a', { tools: 2 }))).toBe(a)
    expect(panelMoment(row, chip('a', { tools: 3 }))).not.toBe(a)
    expect(panelMoment({ ...row, state: 'done' }, null)).not.toBe(panelMoment(row, null))
  })

  it('agentWidth: beside a conversation that keeps AG_CONVO, else over it', () => {
    expect(agentWidth(null, 1400)).toEqual({ width: AG_DEFAULT, over: false })
    expect(agentWidth(9999, 1400)).toEqual({ width: AG_MAX, over: false })
    expect(agentWidth(10, 1400)).toEqual({ width: AG_MIN, over: false })
    expect(agentWidth(500, AG_CONVO + 300)).toEqual({ width: 300, over: false })
    const tight = agentWidth(null, 500)
    expect(tight.over).toBe(true)
    expect(tight.width).toBeLessThanOrEqual(476)
  })
})
