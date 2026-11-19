/**
 * 보기 정도 in the session header (only while the chat is shown): the eye, the
 * level's name and a chevron. The menu holds the three levels (src/chat/density.ts), each with its one-line
 * hint; the chosen one is checked on the quiet selection grey (never yellow). It works from the keyboard as the
 * text-size menu does: ↓ / ↑ on the button open it on the checked level, ↓ / ↑ / Home / End move, Enter or
 * Space picks, Esc and Tab close it, and the focus comes back to the button. A narrow window keeps the eye and
 * the chevron; the name stays in the button's name for a screen reader.
 */

import React, { useEffect, useRef, useState } from 'react'
import { t, tSense } from '../../i18n'
import { menuKeyIndex } from '../../menuKeys'
import { DENSITIES, DENSITY_HINT, DENSITY_LABEL, DENSITY_SENSE, useDensity, writeDensity, type Density } from '../../chat/density'
import { CheckIcon } from '../Icons'
import { ChevDownIcon, EyeIcon } from './ChatIcons'

/** A level's name in the page's language (기본 with its sense: 基本, not 設定の既定) */
export const densityName = (d: Density): string => (d === 'default' ? tSense(DENSITY_LABEL[d], DENSITY_SENSE) : t(DENSITY_LABEL[d]))

export const DensityMenu: React.FC = () => {
  const density = useDensity()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    box.current?.querySelector<HTMLElement>('.w-dens-item.on')?.focus()
    const onDown = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation()
        setOpen(false)
        btn.current?.focus()
        return
      }
      // (from the button, so Tab goes on to the next control)
      if (e.key === 'Tab') { setOpen(false); btn.current?.focus(); return }
      const items = [...(box.current?.querySelectorAll<HTMLElement>('.w-dens-item') ?? [])]
      const at = items.indexOf(document.activeElement as HTMLElement)
      if (at < 0 || e.altKey || e.ctrlKey || e.metaKey) return
      const next = menuKeyIndex(e.key, at, items.length)
      if (next === null) return
      e.preventDefault(); e.stopPropagation()
      items[next].focus()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  const name = densityName(density)
  return (
    <div className="w-dens-anchor" ref={box}>
      <button type="button" className={`w-dens${open ? ' open' : ''}`} ref={btn}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => { if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setOpen(true) } }}
        title={t('보기 정도')} aria-label={`${t('보기 정도')}: ${name}`} aria-haspopup="menu" aria-expanded={open}>
        <EyeIcon size={14} /><span className="w-dens-name">{name}</span><ChevDownIcon size={12} />
      </button>
      {open && (
        <div className="w-dens-menu" role="menu" aria-label={t('보기 정도')}>
          {DENSITIES.map(d => (
            <button key={d} type="button" role="menuitemradio" aria-checked={d === density} tabIndex={-1} className={`w-dens-item${d === density ? ' on' : ''}`}
              onClick={() => { writeDensity(d); setOpen(false); btn.current?.focus() }}>
              <span className="w-dens-ck"><CheckIcon size={12} /></span>
              <span className="w-dens-text"><span className="w-dens-item-name">{densityName(d)}</span><small>{t(DENSITY_HINT[d])}</small></span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default DensityMenu
