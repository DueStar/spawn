/**
 * The latest catches beside the Pokédex count in the side panel. As many as fit whole are shown, newest first; when
 * the panel narrows the oldest go first, folding away (width and opacity) instead of being cut at the edge.
 */

import React, { useLayoutEffect, useRef, useState } from 'react'

export interface RecentMon { key: string; src: string; name: string; shiny: boolean }

/** How many icons of `icon` px with `gap` px between them fit whole in `width` px (never more than `max`) */
export function fitCount(width: number, icon: number, gap: number, max: number): number {
  if (!(width > 0) || !(icon > 0)) return 0
  return Math.max(0, Math.min(max, Math.floor((width + gap) / (icon + gap))))
}

const MAX = 4
const GAP = 3

export const DexRecent: React.FC<{ mons: RecentMon[] }> = ({ mons }) => {
  const box = useRef<HTMLSpanElement>(null)
  const [fit, setFit] = useState(MAX)
  useLayoutEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const icon = parseFloat(getComputedStyle(el).getPropertyValue('--w-icon')) || 20
      setFit(fitCount(el.clientWidth, icon, GAP, MAX))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <span className="w-dex-recent" ref={box}>
      {mons.slice(0, MAX).map((m, i) => (
        <img key={m.key} src={m.src} alt={i < fit ? m.name : ''} aria-hidden={i < fit ? undefined : true}
          className={i < fit ? undefined : 'out'} title={`${m.shiny ? '✨ ' : ''}${m.name}`} draggable={false} />
      ))}
    </span>
  )
}

export default DexRecent
