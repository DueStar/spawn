/**
 * BrandMenu — the logo (the ball, in the left panel's header and on the folded rail) opens a small menu:
 * 패치노트 · 설정 (2026-11-27: the gear went; in 업무 모드 no ball is drawn and the gear stays).
 * It works as the text-size menu does (TextSizeControl): it opens on its first item, ↓ / ↑ / Home / End move,
 * Enter or Space picks, Esc and Tab close it and the focus comes back to the logo, a press outside closes it.
 * Drawn `position: fixed` under the logo, so the rail's 56px column and the header never clip it.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import { menuKeyIndex } from '../menuKeys'

interface Props {
  className: string
  title: string
  onNotes(): void
  onSettings(): void
  children: React.ReactNode
  /** the menu drawn open at first (the tests' static render) */
  initialOpen?: boolean
}

export const BrandMenu: React.FC<Props> = ({ className, title, onNotes, onSettings, children, initialOpen = false }) => {
  const [open, setOpen] = useState(initialOpen)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open || !button.current) return
    const r = button.current.getBoundingClientRect()
    setAt({ left: Math.round(r.left), top: Math.round(r.bottom + 6) })
  }, [open])

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('.w-brand-item')?.focus()
    const close = (back: boolean) => { setOpen(false); if (back) button.current?.focus() }
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node
      if (!menu.current?.contains(n) && !button.current?.contains(n)) close(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return }
      if (e.key === 'Tab') { close(true); return }
      const items = [...(menu.current?.querySelectorAll<HTMLElement>('.w-brand-item') ?? [])]
      const i = items.indexOf(document.activeElement as HTMLElement)
      if (i < 0 || e.altKey || e.ctrlKey || e.metaKey) return
      const next = menuKeyIndex(e.key, i, items.length)
      if (next === null) return
      e.preventDefault(); e.stopPropagation()
      items[next].focus()
    }
    const onResize = () => close(false)
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  const pick = (fn: () => void) => { setOpen(false); fn() }
  return (
    <>
      <button ref={button} className={className} onClick={() => setOpen(o => !o)} title={title} aria-label={title}
        aria-haspopup="menu" aria-expanded={open}
        onKeyDown={e => { if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setOpen(true) } }}>
        {children}
      </button>
      {open && (
        <div ref={menu} className="w-brand-menu" role="menu" aria-label={title}
          style={at ? { left: at.left, top: at.top } : { visibility: 'hidden' }}>
          <button type="button" role="menuitem" tabIndex={-1} className="w-brand-item" onClick={() => pick(onNotes)}>{t('패치노트')}</button>
          <button type="button" role="menuitem" tabIndex={-1} className="w-brand-item" onClick={() => pick(onSettings)}>{t('설정')}</button>
        </div>
      )}
    </>
  )
}

export default BrandMenu
