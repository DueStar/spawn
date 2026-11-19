/**
 * A wild Pokémon met in the flow: the 34px
 * picture, 야생의 {name}{iga} 나타났다, →, then the ball and 잡았다 · Lv.n (with a hairline 새로 등록 for a first of its
 * species) or 놓쳤다. A shiny one says 색이 다른; a rare-or-above one names its tier in the tier's colour. A screen
 * reader hears it as one sentence (role="note"); the drawn line is hidden from it.
 *
 * It comes only from the game's own events (src/chat/wild.ts) and draws nothing in 업무 모드 (ChatView gives it no
 * entries there either). Its one entry animation (chat-game.css) plays once, for a meeting that happened while the
 * view was open (`wildNew`), never for one that was there when it opened or after a reload.
 */

import React, { useEffect, useState } from 'react'
import { josa, nameOf, t } from '../../i18n'
import { pokemonById, spriteUrl } from '../../theme'
import { TIER_LABEL, ballUrl } from '../../pokedexStore'
import type { WildEntry } from '../../chat/wild'
import { useChatContext } from './context'

export const WildRow: React.FC<{ rowKey: string; entry: WildEntry }> = ({ rowKey, entry }) => {
  const { workMode, wildNew, wildPlayed } = useChatContext()
  // decided once, when the row first mounts: a row scrolled out and back does not play again
  const [appear] = useState(() => !workMode && !!wildNew?.(rowKey))
  useEffect(() => { if (appear) wildPlayed?.(rowKey) }, [appear, rowKey, wildPlayed])
  if (workMode) return null

  const name = nameOf(pokemonById(entry.dex)) || `No.${entry.dex}`
  const iga = josa(name, '이가')
  const appeared = t('야생의 {name}{iga} 나타났다', { name, iga })
  const [before, after = ''] = t('야생의 {name}{iga} 나타났다', { iga }).split('{name}')
  const shiny = entry.shiny ? t('색이 다른') : null
  const tier = entry.tier && entry.tier !== 'common' ? TIER_LABEL[entry.tier] : null
  const result = entry.kind === 'catch' ? `${t('잡았다')}${entry.level !== null ? ` · Lv.${entry.level}` : ''}` : t('놓쳤다')
  const fresh = entry.kind === 'catch' && entry.newSpecies ? t('새로 등록') : null
  const sentence = [appeared, shiny, tier, result, fresh].filter(Boolean).join(', ')

  return (
    <div className={`chat-wild${appear ? ' appear' : ''}`} role="note">
      <span className="chat-sr">{sentence}</span>
      <span className="chat-wild-line" aria-hidden="true">
        <img className="chat-wild-mon" src={spriteUrl(entry.dex, entry.shiny)} alt="" draggable={false} />
        <span>{before}<b>{name}</b>{after}</span>
        {shiny && <span className="chat-wild-tag">{shiny}</span>}
        {tier && <span className={`chat-wild-tier tier-${entry.tier}`}><i className="tdot" aria-hidden="true" />{tier}</span>}
        <span className="chat-wild-arrow">→</span>
        <span className="chat-wild-got">
          {entry.kind === 'catch' && <img className="chat-wild-ball" src={ballUrl(entry.ball)} alt="" draggable={false} />}
          {result}
        </span>
        {fresh && <span className="chat-wild-tag">{fresh}</span>}
      </span>
    </div>
  )
}

export default WildRow
