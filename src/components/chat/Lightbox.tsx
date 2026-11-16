/**
 * A picture shown large over the chat view (the lab's `.lightbox`): the view dimmed, the
 * image at most min(760px, 80vw), its caption. A modal dialog: the focus goes to its close
 * button, Esc or a click anywhere closes it, and the focus returns to what opened it.
 * Nothing moves in or out (no animation).
 */

import React, { useEffect, useRef } from 'react'
import { t } from '../../i18n'
import { XIcon } from './ChatIcons'

export const Lightbox: React.FC<{ url: string; caption: string; onClose(): void }> = ({ url, caption, onClose }) => {
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => { close.current?.focus({ preventScroll: true }) }, [])
  return (
    <div
      className="chat-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={caption}
      onClick={onClose}
      onKeyDown={e => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); onClose() }
        // the focus stays inside the dialog
        if (e.key === 'Tab') { e.preventDefault(); close.current?.focus() }
      }}
    >
      <figure onClick={e => e.stopPropagation()}>
        <img src={url} alt={caption} draggable={false} onClick={onClose} />
        <figcaption>{caption}</figcaption>
      </figure>
      <button ref={close} type="button" className="chat-lightbox-x" onClick={onClose} aria-label={t('닫기')} title={`${t('닫기')} (Esc)`}><XIcon size={14} /></button>
    </div>
  )
}

export default Lightbox
