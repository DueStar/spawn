// A drag the app follows itself, from pointer events (not the browser's drag and drop): the system
// draws no drag cursor of its own (on Windows an arrow with a dotted box), the cursor is the app's
// grabbing hand (body.pointer-dragging, widget.css), and nothing is copied anywhere.
// A press that moves less than DRAG_START_PX is a click; past it the drag starts, follows the
// pointer, drops where it is let go (and the click the release would make is eaten). Esc, a
// cancelled pointer or the window losing focus put it back (onCancel).

export const DRAG_START_PX = 4

export type Point = { x: number; y: number }
export type DragHandlers = {
  onStart(from: Point, now: Point): void
  onMove(now: Point): void
  onDrop(at: Point): void
  onCancel(): void
}
type Down = { clientX: number; clientY: number; button: number; pointerId: number }
type Win = Pick<Window, 'addEventListener' | 'removeEventListener'> & { document: { body: { classList: { add(c: string): void; remove(c: string): void } }; getSelection?: () => { removeAllRanges(): void } | null } }

export function trackPointerDrag(down: Down, h: DragHandlers, win: Win = window as unknown as Win): void {
  if (down.button !== 0) return
  const from = { x: down.clientX, y: down.clientY }
  let started = false
  const body = win.document.body
  const at = (e: Event) => ({ x: (e as PointerEvent).clientX, y: (e as PointerEvent).clientY })
  const mine = (e: Event) => (e as PointerEvent).pointerId === down.pointerId
  const move = (e: Event) => {
    if (!mine(e)) return
    const p = at(e)
    if (!started) {
      if (Math.hypot(p.x - from.x, p.y - from.y) < DRAG_START_PX) return
      started = true
      body.classList.add('pointer-dragging')
      win.document.getSelection?.()?.removeAllRanges()
      h.onStart(from, p)
      return
    }
    h.onMove(p)
  }
  const up = (e: Event) => {
    if (!mine(e)) return
    const was = started
    stop()
    if (!was) return
    // the release's click (on the row or cell, or wherever it landed) is not a click
    let live = true
    const eat = (c: Event) => { if (!live) return; live = false; c.preventDefault(); c.stopPropagation() }
    win.addEventListener('click', eat, { capture: true, once: true })
    setTimeout(() => { live = false; win.removeEventListener('click', eat, { capture: true }) }, 0)
    h.onDrop(at(e))
  }
  const cancel = (e: Event) => {
    if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return
    if (e.type === 'pointercancel' && !mine(e)) return
    const was = started
    stop()
    if (was) { e.preventDefault(); h.onCancel() }
  }
  function stop() {
    win.removeEventListener('pointermove', move)
    win.removeEventListener('pointerup', up)
    win.removeEventListener('pointercancel', cancel)
    win.removeEventListener('keydown', cancel, true)
    win.removeEventListener('blur', cancel)
    if (started) body.classList.remove('pointer-dragging')
  }
  win.addEventListener('pointermove', move)
  win.addEventListener('pointerup', up)
  win.addEventListener('pointercancel', cancel)
  win.addEventListener('keydown', cancel, true)
  win.addEventListener('blur', cancel)
}
