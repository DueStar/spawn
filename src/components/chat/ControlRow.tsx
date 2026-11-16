/**
 * The composer's quiet control row (the lab's `.ctrl`), display only (the plan's Decision 12):
 * the model, the permission mode the hooks report (hidden while not known), the context left
 * as the side panel shows it (HP, or 컨텍스트 in 업무 모드, with its green / amber / red), and
 * the 5-hour and weekly usage. No menus: each says it is changed in the terminal (the chat
 * never sends a configuration command).
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { lang, t } from '../../i18n'
import { useTextStep } from '../../textSize'
import { hpTone } from '../../sessionList'
import type { PermissionMode } from '../../chat/types'
import { CpuIcon, ShieldIcon } from './ChatIcons'

export interface ComposerControl {
  model: string | null
  /** left: the context left in %, tip: the side panel's tooltip; label: the side panel's barLabel */
  context: { left: number | null; tip: string; label: 'HP' | '컨텍스트' }
  usage: { fiveHour?: number; weekly?: number }
}

const MODE: Record<PermissionMode, string> = {
  default: '매번 확인',
  acceptEdits: '편집 자동 허용',
  plan: '계획 모드',
  auto: '자동 모드',
  bypassPermissions: '확인 없이 실행',
  dontAsk: '묻지 않음',
}

/**
 * A narrow composer (a 560px window with the left panel open, a large text step, a long en / ja word) gives way a
 * step at a time, as the top bar does (Widget.tsx barLevel), so nothing is ever clipped: 1 the weekly usage goes,
 * 2 the 5-hour usage too (both stay in the side panel's usage bars and in the item's title), 3 the permission mode
 * keeps only its icon, 4 the model too (each named in its title and its accessible name). HP stays: it is this
 * session's own. A step comes back once the row is wide enough again for the width it needed.
 */
export const CTRL_LEVELS = 4
/** (measured in the page only: a server render, as the tests make, has nothing to measure) */
const useLayoutEffectInPage = typeof window === 'undefined' ? useEffect : useLayoutEffect

export const ControlRow: React.FC<{ control: ComposerControl; mode: PermissionMode | null | undefined }> = ({ control, mode }) => {
  const change = t('바꾸려면 터미널에서 해요')
  const { left, tip, label } = control.context
  const pct = (v: number) => `${Math.round(v)}%`
  const modeKey = mode ? MODE[mode] : undefined
  const rowRef = useRef<HTMLDivElement>(null)
  const [level, setLevel] = useState(0)
  const needed = useRef<number[]>([])
  const textStep = useTextStep()
  const content = [control.model, modeKey, left === null, control.usage.fiveHour !== undefined, control.usage.weekly !== undefined, lang(), textStep].join('|')
  const contentSeen = useRef(content)
  useLayoutEffectInPage(() => {
    const row = rowRef.current
    if (contentSeen.current !== content) {
      contentSeen.current = content
      needed.current = []
      if (level !== 0) { setLevel(0); return }
    }
    if (!row) return
    // The width its items need: past the row's right edge, plus any text an item cuts (an ellipsis is a cut too)
    const measure = () => {
      const r = row.getBoundingClientRect()
      let over = 0
      for (const kid of row.querySelectorAll<HTMLElement>('.chat-ctrl-item, .chat-ctrl-meter, .chat-ctrl-item > b, .chat-ctrl-item > span')) {
        const k = kid.getBoundingClientRect()
        if (!k.width) continue
        over = Math.max(over, k.right - r.right, kid.scrollWidth - kid.clientWidth)
      }
      return { need: r.width + Math.max(0, over), have: r.width, over }
    }
    const check = () => {
      const { need, have, over } = measure()
      if (over > 0.5) {
        if (level < CTRL_LEVELS) { needed.current[level] = need; setLevel(level + 1) }
      } else if (level > 0 && have >= (needed.current[level - 1] ?? Infinity) + 8) setLevel(level - 1)
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(row)
    return () => ro.disconnect()
  }, [level, content])
  const showWeekly = control.usage.weekly !== undefined && level < 1
  const showFive = control.usage.fiveHour !== undefined && level < 2
  const modelName = `${t('모델')} ${control.model ?? ''}`
  const modeName = modeKey ? `${t('권한 모드')} ${t(modeKey)}` : ''
  return (
    <div className="chat-ctrl" ref={rowRef} data-level={level}>
      {control.model && <span className="chat-ctrl-item" title={`${t('모델')} ${control.model} · ${change}`} aria-label={level >= 4 ? modelName : undefined}><CpuIcon />{level < 4 && <b>{control.model}</b>}</span>}
      {modeKey && <span className="chat-ctrl-item" title={`${t('권한 모드')} ${t(modeKey)} · ${change}`} aria-label={level >= 3 ? modeName : undefined}><ShieldIcon />{level < 3 && <b>{t(modeKey)}</b>}</span>}
      <span className="chat-ctrl-grow" />
      {/* (context not known yet: no value, and a text that says so, never a full 100) */}
      <span className="chat-ctrl-meter" title={tip} role="meter" aria-label={tip} aria-valuenow={left ?? undefined} aria-valuetext={left === null ? t('알 수 없음') : undefined} aria-valuemin={0} aria-valuemax={100}>
        <span className="chat-ctrl-label" aria-hidden="true">{label === 'HP' ? 'HP' : t(label)}</span>
        <span className={`chat-ctx ${hpTone(left)}`} aria-hidden="true"><i style={{ width: `${left ?? 100}%` }} /></span>
        <span aria-hidden="true">{left === null ? '—' : pct(left)}</span>
      </span>
      {(showFive || showWeekly) && <>
        <span className="chat-ctrl-sep" aria-hidden="true" />
        <span className="chat-ctrl-item" title={`${t('사용량')} · ${change}`}>
          {showFive && <span>{t('5시간')} {pct(control.usage.fiveHour!)}</span>}
          {showWeekly && <span>{t('주간')} {pct(control.usage.weekly!)}</span>}
        </span>
      </>}
    </div>
  )
}

export default ControlRow
