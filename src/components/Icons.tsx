/**
 * Icons — one icon system: icons from Phosphor, one weight, a few sizes (mixed stroke widths drawn at
 * 11–16px read thick here and thin there).
 *
 *   weight  bold everywhere (24/256 of the size: 1.5px at 16, 1.3px at 14, 1.1px at 12)
 *   sizes   16 a button's icon · 14 an icon inside a line of text · 12 a small caret or ×
 *
 * Phosphor (MIT, phosphoricons.com) first; Hugeicons or Material only where Phosphor has nothing that fits. The
 * window buttons stay Windows' own shapes (minimize, maximize, restore), drawn at the same 1.5px. And spawn's
 * Poké Ball (an original drawing, tools/build-icons.py: the same ball as the app icon).
 */

import React, { useState } from 'react'
// (one module per icon: the whole set is 3000+ icons, which a test or a build should never load)
import type { Icon as PhIcon } from '@phosphor-icons/react/dist/lib/types'
import { AppWindowIcon as AppWindow } from '@phosphor-icons/react/dist/csr/AppWindow'
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/dist/csr/ArrowClockwise'
import { ArrowLineDownIcon as ArrowLineDown } from '@phosphor-icons/react/dist/csr/ArrowLineDown'
import { ArrowsLeftRightIcon as ArrowsLeftRight } from '@phosphor-icons/react/dist/csr/ArrowsLeftRight'
import { BookOpenIcon as BookOpen } from '@phosphor-icons/react/dist/csr/BookOpen'
import { CalendarBlankIcon as CalendarBlank } from '@phosphor-icons/react/dist/csr/CalendarBlank'
import { CheckIcon as Check } from '@phosphor-icons/react/dist/csr/Check'
import { CornersOutIcon as CornersOut } from '@phosphor-icons/react/dist/csr/CornersOut'
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder'
import { GearIcon as Gear } from '@phosphor-icons/react/dist/csr/Gear'
import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass'
import { PackageIcon as Package } from '@phosphor-icons/react/dist/csr/Package'
import { PaperPlaneRightIcon as PaperPlaneRight } from '@phosphor-icons/react/dist/csr/PaperPlaneRight'
import { PictureInPictureIcon as PictureInPicture } from '@phosphor-icons/react/dist/csr/PictureInPicture'
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus'
import { SidebarSimpleIcon as SidebarSimple } from '@phosphor-icons/react/dist/csr/SidebarSimple'
import { StackIcon as Stack } from '@phosphor-icons/react/dist/csr/Stack'
import { TerminalIcon as Terminal } from '@phosphor-icons/react/dist/csr/Terminal'
import { TrophyIcon as Trophy } from '@phosphor-icons/react/dist/csr/Trophy'
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X'
import { ballUrl } from '../pokedexStore'

type P = { size?: number; className?: string }

/** One weight for every icon of the app (the system above) */
export const ICON_WEIGHT = 'bold' as const
/** The sizes an icon may be drawn at */
export const ICON_SIZES = Object.freeze({ button: 16, inline: 14, small: 12 })

/** The step a size is drawn at: 12, 14 or 16 (a size over 17 is a picture-sized icon, drawn as asked) */
export const iconStep = (size: number): number => (size > 17 ? size : size <= 12.5 ? ICON_SIZES.small : size < 15 ? ICON_SIZES.inline : ICON_SIZES.button)

/** A Phosphor icon as the app draws one: its size (on a step; 16 by default), the one weight, currentColor, decorative */
export const ph = (Comp: PhIcon, fallback: number = ICON_SIZES.button): React.FC<P> => {
  const C: React.FC<P> = ({ size = fallback, className }) => (
    <Comp className={`ico${className ? ` ${className}` : ''}`} size={iconStep(size)} weight={ICON_WEIGHT} aria-hidden="true" focusable="false" />
  )
  return C
}

/** The window buttons' own shapes (Windows draws them so), at the same stroke as the system: 1.5 on a 16 grid */
const Svg: React.FC<P & { children: React.ReactNode }> = ({ size = 16, className, children }) => (
  <svg className={`ico${className ? ` ${className}` : ''}`} width={iconStep(size)} height={iconStep(size)} viewBox="0 0 16 16" fill="none"
    stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)

/** A folder: open a session somewhere else */
export const FolderIcon = ph(Folder)
/** Stacked sessions: pick one of the earlier sessions */
export const SessionsIcon = ph(Stack)
/** >_ */
export const TerminalIcon = ph(Terminal)
/** The Pokédex: an open book */
export const DexIcon = ph(BookOpen)
/** The PC box */
export const BoxIcon = ph(Package)
/** Widget: a small window over the others */
export const WidgetModeIcon = ph(PictureInPicture)
/** Window: an app window */
export const WindowModeIcon = ph(AppWindow)
/** Maximize (as Windows draws it): one square — the window fills the screen */
export const MaximizeIcon: React.FC<P> = (p) => (
  <Svg {...p}><rect x="3.5" y="3.5" width="9" height="9" rx="1.2" /></Svg>
)
/** Restore (as Windows draws it): two squares — back to the window */
export const RestoreIcon: React.FC<P> = (p) => (
  <Svg {...p}><rect x="2.8" y="5.2" width="8" height="8" rx="1.2" /><path d="M5.2 5.2V4a1.2 1.2 0 0 1 1.2-1.2H12a1.2 1.2 0 0 1 1.2 1.2v5.6a1.2 1.2 0 0 1-1.2 1.2h-1.2" /></Svg>
)
/** Fullscreen: four corners */
export const FullscreenIcon = ph(CornersOut)
/** Today's log */
export const TodayIcon = ph(CalendarBlank)
/** A trophy: 랭킹 */
export const RankIcon = ph(Trophy)
/** A line: minimize the window (as Windows draws it) */
export const MinimizeIcon: React.FC<P> = (p) => (
  <Svg {...p}><path d="M3.5 8h9" /></Svg>
)
/** A window with its left column: show or hide the side panel */
export const SidePanelIcon = ph(SidebarSimple)
/** Two opposed arrows: swap the Pokémon working a session */
export const SwapIcon = ph(ArrowsLeftRight)
/** × : close */
export const CloseIcon = ph(X)
/** ✓ : the chosen one in a menu */
export const CheckIcon = ph(Check)
/** A paper plane: send the instruction */
export const SendIcon = ph(PaperPlaneRight)
export const SearchIcon = ph(MagnifyingGlass)
export const PlusIcon = ph(Plus)
/** An arrow down onto a line: an update to take (the update button) */
export const UpdateIcon = ph(ArrowLineDown)
/** An update downloaded: restart to apply it (told apart from 'one to get') */
export const RestartIcon = ph(ArrowClockwise)
/** 설정 */
export const GearIcon = ph(Gear)

/**
 * A Poké Ball picture: the games' ball artwork shipped with the app (without `ball`, the
 * Poké Ball). Where that art is missing, public/sprites/spawn-ball.png, the same Dream
 * World Poké Ball as the app, tray and window icons (NOTICE.md).
 */
export const PokeBall: React.FC<{ size?: number; className?: string; ball?: string | null; title?: string }> = ({ size = 16, className, ball, title }) => {
  const [failed, setFailed] = useState(false)
  return (
    <img
      className={`pokeball${className ? ` ${className}` : ''}`}
      src={failed ? '/sprites/spawn-ball.png' : ballUrl(ball ?? 'poke-ball')}
      width={size}
      height={size}
      alt={title ?? ''}
      title={title}
      draggable={false}
      onError={() => setFailed(true)}
    />
  )
}
