/**
 * The pictures an item shows (src/chat/pictures.ts), as thumbnails under it: each read from
 * main when the row is drawn (only one the conversation names), shown through a blob: URL
 * that goes when the row does; a click shows it large (the Lightbox). One that cannot be read
 * says so in a line, never a broken image.
 */
import React, { useEffect, useState } from 'react'
import { t } from '../../i18n'
import { baseName } from '../../chat/mentions'
import { useChatContext } from './context'

type Shot = { state: 'loading' } | { state: 'ok'; url: string; blob: Blob } | { state: 'none' }

const Picture: React.FC<{ path: string }> = ({ path }) => {
  const { loadPicture, openImage } = useChatContext()
  const [shot, setShot] = useState<Shot>({ state: 'loading' })
  useEffect(() => {
    let url: string | null = null
    let gone = false
    loadPicture?.(path).then(r => {
      if (gone) return
      if (!r) { setShot({ state: 'none' }); return }
      const blob = new Blob([r.bytes as BlobPart], { type: r.type })
      url = URL.createObjectURL(blob)
      setShot({ state: 'ok', url, blob })
    }, () => { if (!gone) setShot({ state: 'none' }) })
    return () => { gone = true; if (url) URL.revokeObjectURL(url) }
  }, [path, loadPicture])
  const name = baseName(path)
  if (shot.state === 'none') return <span className="chat-shot-none" title={path}>{t('그림을 불러오지 못했어요: {name}', { name })}</span>
  if (shot.state === 'loading') return <span className="chat-shot chat-shot-wait" aria-hidden="true" />
  return (
    <button type="button" className="chat-shot" title={path} aria-label={`${t('크게 보기')}: ${name}`}
      // the Lightbox gets a URL of its own (revoked when it closes): this row's may go while it is open
      onClick={e => openImage?.(URL.createObjectURL(shot.blob), name, e.currentTarget, true)}>
      <img src={shot.url} alt="" draggable={false} />
    </button>
  )
}

export const Pictures: React.FC<{ paths: string[] }> = ({ paths }) => {
  const { loadPicture } = useChatContext()
  if (!paths.length || !loadPicture) return null
  return <div className="chat-shots">{paths.map(p => <Picture key={p} path={p} />)}</div>
}
