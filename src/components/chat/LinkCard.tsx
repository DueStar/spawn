/**
 * A link preview card (Phase 5, opt-in; the lab's `.og`, calm-lab app.css 223–230, app.js 386–401): after the
 * block of a finished answer that holds the link. A hairline box at most 480px wide: the site line (a neutral
 * globe, the link's own host, `→ final host` when a redirect left it), the title on one line, the description on
 * two, and the picture at 104×68 on the right when there is one. The whole card is one link that opens the
 * address as written through the app (openUrlFromChat: http/https only), named `링크 미리보기: {title}`, the
 * address in its title.
 *
 * It draws nothing until its card arrives, and nothing when there is none (refused, failed, off): the plain link
 * above stays. Its card is asked for only once it is mounted (src/chat/preview.ts usePreview), so a row the
 * virtual list never drew asks nothing. Its picture is a blob: URL the page made, never a remote address.
 * Nothing of the game: it shows in 업무 모드 as it is.
 */

import React from 'react'
import { t } from '../../i18n'
import { openUrlFromChat } from '../../chat/lensMode'
import { usePreview } from '../../chat/preview'
import { useChatContext } from './context'

const Globe = () => (
  <svg className="chat-og-globe" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <circle cx="8" cy="8" r="6.3" /><path d="M1.7 8h12.6" /><path d="M8 1.7c1.8 1.9 2.6 4 2.6 6.3S9.8 12.4 8 14.3C6.2 12.4 5.4 10.3 5.4 8S6.2 3.6 8 1.7z" />
  </svg>
)

export const LinkCard: React.FC<{ url: string }> = ({ url }) => {
  const { id, previews } = useChatContext()
  const card = usePreview(url, previews === true, id)
  if (!card) return null
  const name = card.title || card.description || card.host
  return (
    // (a middle click or a drag of "#" goes nowhere: the address only ever leaves through openUrlFromChat)
    <a className={`chat-og${card.src ? ' has-img' : ''}`} href="#" title={card.url} aria-label={t('링크 미리보기: {title}', { title: name })}
      onClick={e => { e.preventDefault(); openUrlFromChat(card.url) }} onAuxClick={e => e.preventDefault()} draggable={false}>
      <span className="chat-og-main">
        <span className="chat-og-site">
          <Globe />
          <span className="chat-og-host">{card.host}</span>
          {card.via && <span className="chat-og-via">→ {card.via}</span>}
        </span>
        {card.title && <span className="chat-og-title">{card.title}</span>}
        {card.description && <span className="chat-og-desc">{card.description}</span>}
      </span>
      {card.src && <img className="chat-og-img" src={card.src} alt="" draggable={false} />}
    </a>
  )
}

export default LinkCard
