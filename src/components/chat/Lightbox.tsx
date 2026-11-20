/**
 * A picture shown large over the whole window (a portal on the body, above every pane and
 * panel): the window dimmed, the picture as large as fits (92% of the width, 84% of the height,
 * never blown up past its own size), its caption. Pictures that came together (the files of one
 * message, one answer's pictures) go through with the side arrows or ← / →, "2 / 3" saying where.
 * A modal dialog: the focus goes to its close button and stays inside, Esc or a click on the dim
 * closes it, and the focus returns to what opened it. Nothing moves in or out (no animation).
 */

import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../../i18n'
import { ChevIcon, XIcon } from './ChatIcons'

export interface Shown { url: string; caption: string }

export const Lightbox: React.FC<{ images: Shown[]; start?: number; onClose(): void }> = ({ images, start = 0, onClose }) => {
  const close = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const n = images.length
  const [at, setAt] = useState(Math.min(Math.max(0, start), Math.max(0, n - 1)))
  useEffect(() => { close.current?.focus({ preventScroll: true }) }, [])
  const go = (d: number) => setAt(i => (i + d + n) % n)
  const cur = images[at]
  if (!cur) return null
  return createPortal(
    <div
      ref={box}
      className="chat-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={cur.caption}
      onClick={onClose}
      onKeyDown={e => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return }
        if (n > 1 && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); e.stopPropagation(); go(e.key === 'ArrowRight' ? 1 : -1); return }
        // the focus stays inside the dialog: its buttons, in turn
        if (e.key === 'Tab') {
          e.preventDefault()
          const btns = [...(box.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
          const i = btns.indexOf(document.activeElement as HTMLButtonElement)
          btns[(i + (e.shiftKey ? -1 : 1) + btns.length) % btns.length]?.focus()
        }
      }}
    >
      <figure onClick={e => e.stopPropagation()}>
        <img key={cur.url} src={cur.url} alt={cur.caption} draggable={false} onClick={onClose} />
        <figcaption>{n > 1 ? `${cur.caption} · ${at + 1} / ${n}` : cur.caption}</figcaption>
      </figure>
      {n > 1 && <>
        <button type="button" className="chat-lightbox-nav prev" onClick={e => { e.stopPropagation(); go(-1) }} aria-label={t('이전 그림')} title={`${t('이전 그림')} (←)`}><ChevIcon size={18} /></button>
        <button type="button" className="chat-lightbox-nav next" onClick={e => { e.stopPropagation(); go(1) }} aria-label={t('다음 그림')} title={`${t('다음 그림')} (→)`}><ChevIcon size={18} /></button>
      </>}
      <button ref={close} type="button" className="chat-lightbox-x" onClick={onClose} aria-label={t('닫기')} title={`${t('닫기')} (Esc)`}><XIcon size={14} /></button>
    </div>,
    document.body,
  )
}

export default Lightbox
