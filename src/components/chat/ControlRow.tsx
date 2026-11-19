/**
 * The composer's quiet control row (the lab's `.ctrl`): the model, the permission mode (hidden while not known),
 * the context left as the side panel shows it (HP, or 컨텍스트 in 업무 모드, with its green / amber / red), and
 * the 5-hour and weekly usage. Since 2026-11-17 the model and the mode are menus (the owner's call: nothing of a
 * chat session should need the terminal): a model sends `/model <alias>`, a mode steps Shift+Tab until the footer
 * shows it (src/chat/modeSwitch.ts). The composer does both; this row only asks.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FooterMode } from '../../chat/promptRow'
import { lang, t } from '../../i18n'
import { useTextStep } from '../../textSize'
import { hpTone } from '../../sessionList'
import type { PermissionMode } from '../../chat/types'
import { CpuIcon, EffortIcon, ShieldIcon } from './ChatIcons'

export interface ComposerControl {
  model: string | null
  /** Claude Code's effort level as its status line last said it (low … max); null / absent: not known */
  effort?: string | null
  /** left: the context left in %, tip: the side panel's tooltip; label: the side panel's barLabel */
  context: { left: number | null; tip: string; label: 'HP' | '컨텍스트' }
  usage: { fiveHour?: number; weekly?: number }
}

/** The models offered (Claude Code's own aliases, read from its binary 2.1.326: default, fable, opus, sonnet, haiku) */
export const MODELS: readonly { alias: string; label: string }[] = [
  { alias: 'default', label: '기본값' }, { alias: 'fable', label: 'Fable' }, { alias: 'opus', label: 'Opus' },
  { alias: 'sonnet', label: 'Sonnet' }, { alias: 'haiku', label: 'Haiku' },
]
/**
 * The effort levels offered (2026-11-19), sent as `/effort <level>` (Claude Code 2.1.327: low, medium, high, xhigh,
 * max, and auto for the model's own default)
 */
export const EFFORTS: readonly { level: string; label: string }[] = [
  { level: 'auto', label: '자동' }, { level: 'low', label: '낮음' }, { level: 'medium', label: '보통' },
  { level: 'high', label: '높음' }, { level: 'xhigh', label: '매우 높음' }, { level: 'max', label: '최대' },
]
/** An effort level's label (Claude Code's own word when it is one this list lacks) */
export function effortLabel(level: string): string {
  const e = EFFORTS.find(x => x.level === level.toLowerCase())
  return e ? t(e.label) : level
}
/** The modes offered, in Claude Code's own Shift+Tab order (auto and bypass only where the session was started so) */
export const MODES_OFFERED: readonly FooterMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']

/** What the row may change now (absent: display only, as before) */
export interface ControlActions {
  onModel(alias: string): void
  /** (absent: no effort menu) */
  onEffort?(level: string): void
  onMode(mode: FooterMode): void
  /** why the model cannot change now (Claude works, a card waits); null: it can */
  modelWhy: string | null
  modeWhy: string | null
  /** modes this session's cycle was seen to lack */
  unreachable: ReadonlySet<FooterMode>
  busy: boolean
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

export const ControlRow: React.FC<{ control: ComposerControl; mode: PermissionMode | null | undefined; actions?: ControlActions }> = ({ control, mode, actions }) => {
  const change = t('눌러서 바꾸기')
  const [menu, setMenu] = useState<'model' | 'effort' | 'mode' | null>(null)
  const { left, tip, label } = control.context
  const pct = (v: number) => `${Math.round(v)}%`
  // (the menu is there even before the mode is known: it reads 권한 모드 until then)
  const modeKey = mode ? MODE[mode] : actions ? '권한 모드' : undefined
  const rowRef = useRef<HTMLDivElement>(null)
  const [level, setLevel] = useState(0)
  const needed = useRef<number[]>([])
  const textStep = useTextStep()
  const content = [control.model, control.effort, modeKey, left === null, control.usage.fiveHour !== undefined, control.usage.weekly !== undefined, lang(), textStep].join('|')
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
  // a click outside the menu, or Esc, closes it
  useEffect(() => {
    if (!menu) return
    const down = (e: PointerEvent) => { if (!rowRef.current?.contains(e.target as Node)) setMenu(null) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setMenu(null) } }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true) }
  }, [menu])
  const showWeekly = control.usage.weekly !== undefined && level < 1
  const showFive = control.usage.fiveHour !== undefined && level < 2
  const modelName = `${t('모델')} ${control.model ?? ''}`
  const modeName = modeKey ? `${t('권한 모드')} ${t(modeKey)}` : ''
  const effortShown = control.effort ? effortLabel(control.effort) : t('생각 정도')
  const effortName = control.effort ? `${t('생각 정도')} ${effortShown}` : effortShown
  return (
    <div className="chat-ctrl" ref={rowRef} data-level={level}>
      {control.model && (actions ? (
        <span className="chat-ctrl-anchor">
          <button type="button" className={`chat-ctrl-item btn${menu === 'model' ? ' open' : ''}`} aria-haspopup="menu" aria-expanded={menu === 'model'}
            title={`${t('모델')} ${control.model} · ${actions.modelWhy ? t(actions.modelWhy) : change}`} aria-label={level >= 4 ? modelName : undefined}
            disabled={actions.busy} onClick={() => setMenu(menu === 'model' ? null : 'model')}><CpuIcon />{level < 4 && <b>{control.model}</b>}</button>
          {menu === 'model' && (
            <span className="chat-ctrl-menu" role="menu" aria-label={t('모델')}>
              {actions.modelWhy && <span className="chat-ctrl-menu-note">{t(actions.modelWhy)}</span>}
              {MODELS.map(m => {
                const on = m.alias !== 'default' && control.model!.toLowerCase().startsWith(m.alias)
                return (
                  <button key={m.alias} type="button" role="menuitemradio" aria-checked={on} className={`chat-ctrl-opt${on ? ' on' : ''}`}
                    disabled={!!actions.modelWhy} onClick={() => { setMenu(null); if (!on) actions.onModel(m.alias) }}>
                    <span className="chat-ctrl-check" aria-hidden="true">{on ? '✓' : ''}</span>{m.alias === 'default' ? t(m.label) : m.label}
                  </button>
                )
              })}
            </span>
          )}
        </span>
      ) : <span className="chat-ctrl-item" title={`${t('모델')} ${control.model}`} aria-label={level >= 4 ? modelName : undefined}><CpuIcon />{level < 4 && <b>{control.model}</b>}</span>)}
      {/* the effort level: a menu sending `/effort <level>` (the same rule as the model: on an idle prompt only) */}
      {actions?.onEffort ? (
        <span className="chat-ctrl-anchor">
          <button type="button" className={`chat-ctrl-item btn${menu === 'effort' ? ' open' : ''}`} aria-haspopup="menu" aria-expanded={menu === 'effort'}
            title={`${effortName} · ${actions.modelWhy ? t(actions.modelWhy) : change}`} aria-label={level >= 3 ? effortName : undefined}
            disabled={actions.busy} onClick={() => setMenu(menu === 'effort' ? null : 'effort')}><EffortIcon />{level < 3 && <b>{effortShown}</b>}</button>
          {menu === 'effort' && (
            <span className="chat-ctrl-menu" role="menu" aria-label={t('생각 정도')}>
              {actions.modelWhy && <span className="chat-ctrl-menu-note">{t(actions.modelWhy)}</span>}
              {EFFORTS.map(e => {
                const on = !!control.effort && control.effort.toLowerCase() === e.level
                return (
                  <button key={e.level} type="button" role="menuitemradio" aria-checked={on} className={`chat-ctrl-opt${on ? ' on' : ''}`}
                    disabled={!!actions.modelWhy} onClick={() => { setMenu(null); if (!on) actions.onEffort!(e.level) }}>
                    <span className="chat-ctrl-check" aria-hidden="true">{on ? '✓' : ''}</span>{t(e.label)}
                  </button>
                )
              })}
            </span>
          )}
        </span>
      ) : control.effort ? <span className="chat-ctrl-item" title={effortName} aria-label={level >= 3 ? effortName : undefined}><EffortIcon />{level < 3 && <b>{effortShown}</b>}</span> : null}
      {modeKey && (actions ? (
        <span className="chat-ctrl-anchor">
          <button type="button" className={`chat-ctrl-item btn${menu === 'mode' ? ' open' : ''}`} aria-haspopup="menu" aria-expanded={menu === 'mode'}
            title={`${t('권한 모드')} ${t(modeKey)} · ${actions.modeWhy ? t(actions.modeWhy) : change}`} aria-label={level >= 3 ? modeName : undefined}
            disabled={actions.busy} onClick={() => setMenu(menu === 'mode' ? null : 'mode')}><ShieldIcon />{level < 3 && <b>{t(modeKey)}</b>}</button>
          {menu === 'mode' && (
            <span className="chat-ctrl-menu" role="menu" aria-label={t('권한 모드')}>
              {actions.modeWhy && <span className="chat-ctrl-menu-note">{t(actions.modeWhy)}</span>}
              {MODES_OFFERED.map(m => {
                const on = m === mode
                const lacks = actions.unreachable.has(m)
                return (
                  <button key={m} type="button" role="menuitemradio" aria-checked={on} className={`chat-ctrl-opt${on ? ' on' : ''}`}
                    disabled={!!actions.modeWhy || lacks} title={lacks ? t('이 세션에서는 고를 수 없어요 (Claude Code를 이 모드로 시작해야 해요)') : undefined}
                    onClick={() => { setMenu(null); if (!on) actions.onMode(m) }}>
                    <span className="chat-ctrl-check" aria-hidden="true">{on ? '✓' : ''}</span>{t(MODE[m])}
                  </button>
                )
              })}
            </span>
          )}
        </span>
      ) : <span className="chat-ctrl-item" title={`${t('권한 모드')} ${t(modeKey)}`} aria-label={level >= 3 ? modeName : undefined}><ShieldIcon />{level < 3 && <b>{t(modeKey)}</b>}</span>)}
      <span className="chat-ctrl-grow" />
      {/* (context not known yet: no value, and a text that says so, never a full 100) */}
      <span className="chat-ctrl-meter" title={tip} role="meter" aria-label={tip} aria-valuenow={left ?? undefined} aria-valuetext={left === null ? t('알 수 없음') : undefined} aria-valuemin={0} aria-valuemax={100}>
        <span className="chat-ctrl-label" aria-hidden="true">{label === 'HP' ? 'HP' : t(label)}</span>
        <span className={`chat-ctx ${hpTone(left)}`} aria-hidden="true"><i style={{ width: `${left ?? 100}%` }} /></span>
        <span aria-hidden="true">{left === null ? '—' : pct(left)}</span>
      </span>
      {(showFive || showWeekly) && <>
        <span className="chat-ctrl-sep" aria-hidden="true" />
        <span className="chat-ctrl-item" title={t('사용량')}>
          {showFive && <span>{t('5시간')} {pct(control.usage.fiveHour!)}</span>}
          {showWeekly && <span>{t('주간')} {pct(control.usage.weekly!)}</span>}
        </span>
      </>}
    </div>
  )
}

export default ControlRow
