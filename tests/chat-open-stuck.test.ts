/**
 * 1.10.14 bug (2026-11-25 16:31 KST): the right side stayed empty after the shown session's terminal exited and
 * came back by 이어하기. The page opened the new terminal's conversation and, when no first answer (a reset) came,
 * waited for ever: "불러오는 중" with nothing to do. Now an open with no reset after OPEN_WAIT_MS asks again once
 * (resync); still nothing after as long again, the view says it could not read (터미널로 보기 · 다시 읽기).
 */
import { describe, expect, it, vi } from 'vitest'
import { createChatStore, OPEN_WAIT_MS } from '../src/chat/store'
import type { ChatUpdate } from '../src/chat/types'

function bridge() {
  let listener: ((u: ChatUpdate) => void) | null = null
  const b = {
    open: vi.fn(async () => ({ ok: true as const })),
    close: vi.fn(),
    reload: vi.fn(async () => ({ ok: true })),
    resync: vi.fn(async () => ({ ok: true })),
    onUpdate: vi.fn((fn: (u: ChatUpdate) => void) => { listener = fn; return () => { listener = null } }),
  }
  return { b, push: (u: ChatUpdate) => listener?.(u) }
}
const reset = (id: string): ChatUpdate => ({ id, rev: 1, ops: [{ op: 'reset', items: [], status: { phase: 'idle' } } as never] })

describe('a conversation opened with no first answer', () => {
  it('asks again once after OPEN_WAIT_MS, then says it could not read', async () => {
    vi.useFakeTimers()
    try {
      const { b } = bridge()
      const store = createChatStore(b)
      store.subscribe('t1-r1', () => {})
      await vi.advanceTimersByTimeAsync(OPEN_WAIT_MS - 100)
      expect(b.resync).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(200)
      expect(b.resync).toHaveBeenCalledTimes(1)
      expect(b.resync).toHaveBeenCalledWith('t1-r1')
      expect((store.get('t1-r1').status as { banner?: unknown } | null)?.banner).toBeUndefined()
      await vi.advanceTimersByTimeAsync(OPEN_WAIT_MS + 100)
      expect(b.resync).toHaveBeenCalledTimes(1)
      expect((store.get('t1-r1').status as { banner?: { reason: string } } | null)?.banner).toEqual({ reason: 'worker' })
    } finally { vi.useRealTimers() }
  })
  it('a reset in time: nothing more is asked', async () => {
    vi.useFakeTimers()
    try {
      const { b, push } = bridge()
      const store = createChatStore(b)
      store.subscribe('t1', () => {})
      await vi.advanceTimersByTimeAsync(500)
      push(reset('t1'))
      await vi.advanceTimersByTimeAsync(OPEN_WAIT_MS * 3)
      expect(b.resync).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
  it('closed before the wait is up: nothing more is asked', async () => {
    vi.useFakeTimers()
    try {
      const { b } = bridge()
      const store = createChatStore(b)
      const off = store.subscribe('t1', () => {})
      off()
      await vi.advanceTimersByTimeAsync(OPEN_WAIT_MS * 3)
      expect(b.resync).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
})
