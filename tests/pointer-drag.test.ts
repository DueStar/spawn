import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { trackPointerDrag, DRAG_START_PX } from '../src/pointerDrag'

// A window stand-in: an EventTarget with a body whose class list the drag marks
const fakeWin = () => {
  const t = new EventTarget() as EventTarget & { document: { body: { classList: Set<string> & { add(c: string): void; remove(c: string): void } } } }
  const cls = new Set<string>()
  ;(t as any).document = { body: { classList: { add: (c: string) => cls.add(c), remove: (c: string) => cls.delete(c), has: (c: string) => cls.has(c) } }, getSelection: () => null }
  return { win: t, cls }
}
const ev = (type: string, p: Record<string, unknown> = {}) => Object.assign(new Event(type, { cancelable: true }), p)
const down = { clientX: 100, clientY: 100, button: 0, pointerId: 1 }

describe('trackPointerDrag: a drag the app follows itself (no system drag cursor)', () => {
  it('a press that moves less than the threshold is a click: no start, no drop, the click goes through', () => {
    const { win } = fakeWin()
    const h = { onStart: vi.fn(), onMove: vi.fn(), onDrop: vi.fn(), onCancel: vi.fn() }
    trackPointerDrag(down, h, win as any)
    win.dispatchEvent(ev('pointermove', { clientX: 102, clientY: 101, pointerId: 1 }))
    win.dispatchEvent(ev('pointerup', { clientX: 102, clientY: 101, pointerId: 1 }))
    const click = ev('click')
    win.dispatchEvent(click)
    expect(h.onStart).not.toHaveBeenCalled()
    expect(h.onDrop).not.toHaveBeenCalled()
    expect(click.defaultPrevented).toBe(false)
  })

  it(`past ${DRAG_START_PX}px it starts, follows the pointer, drops where it is let go, and eats the click after`, () => {
    const { win, cls } = fakeWin()
    const h = { onStart: vi.fn(), onMove: vi.fn(), onDrop: vi.fn(), onCancel: vi.fn() }
    trackPointerDrag(down, h, win as any)
    win.dispatchEvent(ev('pointermove', { clientX: 100, clientY: 100 + DRAG_START_PX, pointerId: 1 }))
    expect(h.onStart).toHaveBeenCalledWith({ x: 100, y: 100 }, { x: 100, y: 100 + DRAG_START_PX })
    expect(cls.has('pointer-dragging')).toBe(true)
    win.dispatchEvent(ev('pointermove', { clientX: 300, clientY: 40, pointerId: 1 }))
    expect(h.onMove).toHaveBeenLastCalledWith({ x: 300, y: 40 })
    win.dispatchEvent(ev('pointerup', { clientX: 310, clientY: 44, pointerId: 1 }))
    expect(h.onDrop).toHaveBeenCalledWith({ x: 310, y: 44 })
    expect(cls.has('pointer-dragging')).toBe(false)
    const click = ev('click')
    win.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    // later clicks are clicks again, and no more moves are followed
    const next = ev('click')
    win.dispatchEvent(next)
    expect(next.defaultPrevented).toBe(false)
    win.dispatchEvent(ev('pointermove', { clientX: 5, clientY: 5, pointerId: 1 }))
    expect(h.onMove).toHaveBeenCalledTimes(1)
  })

  it('Esc, a cancelled pointer or the window losing focus put it back: cancel, never drop', () => {
    for (const end of [ev('keydown', { key: 'Escape' }), ev('pointercancel', { pointerId: 1 }), ev('blur')]) {
      const { win, cls } = fakeWin()
      const h = { onStart: vi.fn(), onMove: vi.fn(), onDrop: vi.fn(), onCancel: vi.fn() }
      trackPointerDrag(down, h, win as any)
      win.dispatchEvent(ev('pointermove', { clientX: 100, clientY: 130, pointerId: 1 }))
      win.dispatchEvent(end)
      win.dispatchEvent(ev('pointerup', { clientX: 100, clientY: 140, pointerId: 1 }))
      expect(h.onCancel, end.type).toHaveBeenCalledTimes(1)
      expect(h.onDrop, end.type).not.toHaveBeenCalled()
      expect(cls.has('pointer-dragging')).toBe(false)
    }
  })

  it('after Esc the release is not a click either (the row would open), and the Esc goes no further', () => {
    const { win } = fakeWin()
    const h = { onStart: vi.fn(), onMove: vi.fn(), onDrop: vi.fn(), onCancel: vi.fn() }
    trackPointerDrag(down, h, win as any)
    win.dispatchEvent(ev('pointermove', { clientX: 100, clientY: 130, pointerId: 1 }))
    const esc = ev('keydown', { key: 'Escape' })
    const heard = vi.fn()
    win.addEventListener('keydown', heard)
    win.dispatchEvent(esc)
    expect(heard).not.toHaveBeenCalled()
    win.dispatchEvent(ev('pointerup', { clientX: 100, clientY: 130, pointerId: 1 }))
    const click = ev('click')
    win.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    const next = ev('click')
    win.dispatchEvent(next)
    expect(next.defaultPrevented).toBe(false)
  })

  it('another pointer (a second finger, a pen) is not this drag', () => {
    const { win } = fakeWin()
    const h = { onStart: vi.fn(), onMove: vi.fn(), onDrop: vi.fn(), onCancel: vi.fn() }
    trackPointerDrag(down, h, win as any)
    win.dispatchEvent(ev('pointermove', { clientX: 100, clientY: 200, pointerId: 2 }))
    expect(h.onStart).not.toHaveBeenCalled()
  })
})

const read = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8')

describe('no native drag in the session list and the box (the system cursor showed a dotted box)', () => {
  it('the list rows and the box cells drag with the pointer, not the browser', () => {
    const w = read('src/Widget.tsx')
    const b = read('src/components/BoxView.tsx')
    for (const [name, src] of [['Widget', w], ['BoxView', b]] as const) {
      expect(src, name).not.toMatch(/onDragStart|setDragImage|effectAllowed/)
      expect(src, name).toContain('trackPointerDrag(')
    }
    expect(w).not.toContain('application/x-spawn-session')
    expect(b).not.toMatch(/\sdraggable(\s|>|=\{?true)/)
  })

  it('while dragging the cursor is a grabbing hand everywhere and nothing gets selected; pictures never start a drag of their own', () => {
    const c = read('src/styles/widget.css')
    expect(c).toMatch(/body\.pointer-dragging,\s*body\.pointer-dragging \*\s*\{[^}]*cursor:\s*grabbing !important[^}]*user-select:\s*none/)
    expect(c).toMatch(/\.w-row img\s*\{[^}]*-webkit-user-drag:\s*none/)
  })
})
