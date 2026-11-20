/**
 * PartyPickers — the two "who goes?" dialogs of the widget, both over every resting Pokémon (in the box, not working
 * a session, not helping a subagent), most recently worked first, with a name search:
 *   SwapPicker   another Pokémon for a running session (or one for a tab without one: currentDex 0)
 *   ThrowPicker  the Pokémon a new (or resumed) session is thrown out with
 */

import React, { useMemo, useState } from 'react'
import { iconUrl, pokemonById } from '../theme'
import { restingUids, levelOf, type DexState, type Mon } from '../pokedexStore'
import type { AiTool } from '../desktop'
import { t, nameOf } from '../i18n'

/** Cells the grid shows at first, and how many more each 더 보기 adds (1,200 resting Pokémon stay fast) */
export const PICKER_PAGE = 120

/** The resting Pokémon, most recently worked first; with a query, those whose shown name has it or whose dex number is it */
export function pickerList(dex: DexState, query: string): Mon[] {
  const q = query.trim().toLowerCase()
  const mons = restingUids(dex).map(uid => dex.mons[uid])
  return q ? mons.filter(m => nameOf(pokemonById(m.dex)).toLowerCase().includes(q) || String(m.dex) === q) : mons
}

const Dialog: React.FC<{ label: string; title: React.ReactNode; onClose: () => void; children: React.ReactNode }> = ({ label, title, onClose, children }) => (
  <div className="resume-backdrop" onClick={onClose}>
    <div className="resume-modal" onClick={e => e.stopPropagation()} role="dialog" aria-label={label}>
      <div className="resume-head">
        <span>{title}</span>
        <button onClick={onClose} aria-label={t('닫기')}>×</button>
      </div>
      {children}
    </div>
  </div>
)

/** The search field and one grid of the resting Pokémon, a page at a time */
const RestingGrid: React.FC<{ dex: DexState; onPick: (uid: string) => void }> = ({ dex, onPick }) => {
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState(PICKER_PAGE)
  const q = query.trim()
  const list = useMemo(() => pickerList(dex, q), [dex, q])
  return <>
    <div className="w-swap-section">
      <input value={query} onChange={e => { setQuery(e.target.value); setShown(PICKER_PAGE) }} placeholder={t('이름 검색')} aria-label={t('이름 검색')} autoFocus />
    </div>
    <div className="w-swap-box">
      {list.length === 0 && <div className="resume-empty">{q ? t('찾는 포켓몬이 없어요') : t('쉬고 있는 포켓몬이 없어요')}</div>}
      {list.slice(0, shown).map(m => {
        const name = nameOf(pokemonById(m.dex))
        const label = `${m.shiny ? '✦ ' : ''}${name} Lv.${levelOf(m)}`
        return (
          <button key={m.uid} className="w-swap-cell" onClick={() => onPick(m.uid)} aria-label={label} title={label}>
            <img src={iconUrl(m.dex)} alt={name} loading="lazy" />
            <span>Lv.{levelOf(m)}</span>
          </button>
        )
      })}
      {list.length > shown && <button className="w-swap-more" onClick={() => setShown(n => n + PICKER_PAGE)}>{t('더 보기')}</button>}
    </div>
  </>
}

export const SwapPicker: React.FC<{ dex: DexState; currentDex: number; onPick: (uid: string) => void; onClose: () => void }> = ({ dex, currentDex, onPick, onClose }) => (
  <Dialog label={currentDex ? t('포켓몬 교체') : t('포켓몬 넣기')} title={currentDex ? t('{name} 대신 보낼 포켓몬', { name: nameOf(pokemonById(currentDex)) }) : t('이 세션에 보낼 포켓몬')} onClose={onClose}>
    <RestingGrid dex={dex} onPick={onPick} />
  </Dialog>
)

/**
 * The Pokémon a new session goes out with, and (when the trainer listed
 * other AI tools in 설정 › 세션) which tool the session runs
 */
export const ThrowPicker: React.FC<{
  dex: DexState; resume: boolean
  tools?: AiTool[]; defaultTool?: string
  onPick: (uid: string, tool: string) => void; onClose: () => void
}> = ({ dex, resume, tools = [], defaultTool = 'claude', onPick, onClose }) => {
  const choices = [{ id: 'claude', name: 'Claude Code' }, ...tools]
  const [tool, setTool] = useState(choices.some(c => c.id === defaultTool) ? defaultTool : 'claude')
  return (
    <Dialog label={t('몬스터볼 던지기')} title={resume ? t('이 세션에 보낼 포켓몬') : t('누구를 보낼까요?')} onClose={onClose}>
      {resume && <div className="w-throw-hint">{t('이 세션의 포켓몬이 다른 세션에서 일하고 있어서, 대신 보낼 포켓몬을 골라주세요.')}</div>}
      {choices.length > 1 && (
        <div className="w-throw-tools" role="radiogroup" aria-label={t('AI 도구')}>
          <span>{t('AI 도구')}</span>
          {choices.map(c => (
            <button key={c.id} role="radio" aria-checked={tool === c.id} className={tool === c.id ? 'on' : ''} onClick={() => setTool(c.id)}>{c.name}</button>
          ))}
        </div>
      )}
      <RestingGrid dex={dex} onPick={uid => onPick(uid, tool)} />
    </Dialog>
  )
}
