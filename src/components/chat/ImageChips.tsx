/**
 * The images attached to the composer's message: a hairline chip with
 * a small picture (a button: it opens the picture large), its name (붙여넣은 이미지 n) and ×
 * (빼기). The picture is the page's own blob URL of the pasted file; the file main keeps is
 * reached only by its token.
 */

import React from 'react'
import { t } from '../../i18n'
import { XIcon } from './ChatIcons'

export interface Chip { token: string; url: string; n: number }

export const ImageChips: React.FC<{
  chips: Chip[]
  onRemove(chip: Chip): void
  onOpen(chip: Chip, from: HTMLElement): void
}> = ({ chips, onRemove, onOpen }) => {
  if (!chips.length) return null
  return (
    <div className="chat-chips">
      {chips.map(c => {
        const name = t('붙여넣은 이미지 {n}', { n: c.n })
        return (
          <span key={c.token} className="chat-ichip">
            <button type="button" className="chat-ichip-pic" onClick={e => onOpen(c, e.currentTarget)} aria-label={`${t('크게 보기')}: ${name}`} title={t('크게 보기')}>
              <img src={c.url} alt="" draggable={false} />
            </button>
            <span className="chat-ichip-name">{name}</span>
            <button type="button" className="chat-ichip-x" onClick={() => onRemove(c)} aria-label={`${t('빼기')}: ${name}`} title={t('빼기')}><XIcon /></button>
          </span>
        )
      })}
    </div>
  )
}

export default ImageChips
