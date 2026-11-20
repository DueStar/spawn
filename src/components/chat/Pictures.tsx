/**
 * The pictures of a row as thumbnails: the ones an item shows (src/chat/pictures.ts, read by path),
 * or the ones the user sent with a message (read again from its transcript line, so they show after
 * a restart too). Each is read from main when the row is drawn, shown through a blob: URL that goes
 * when the row does; a click shows the row's pictures large together (the Lightbox). One that cannot
 * be read says so in a line, never a broken image.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../../i18n'
import { baseName } from '../../chat/mentions'
import { useChatContext } from './context'

type Shot = { state: 'loading' } | { state: 'ok'; url: string; blob: Blob } | { state: 'none' }
type Loaded = { type: string; bytes: Uint8Array } | null
/** Where a row's pictures come from: how to read one (by its key) and what to call it */
export interface PictureSource { load(key: string): Promise<Loaded>; caption(key: string): string; title?(key: string): string }

const Picture: React.FC<{ k: string; source: PictureSource; report(k: string, blob: Blob | null): void; open(k: string, from: HTMLElement): void }> = ({ k, source, report, open }) => {
  const [shot, setShot] = useState<Shot>({ state: 'loading' })
  useEffect(() => {
    let url: string | null = null
    let gone = false
    source.load(k).then(r => {
      if (gone) return
      if (!r) { setShot({ state: 'none' }); return }
      const blob = new Blob([r.bytes as BlobPart], { type: r.type })
      url = URL.createObjectURL(blob)
      setShot({ state: 'ok', url, blob })
      report(k, blob)
    }, () => { if (!gone) setShot({ state: 'none' }) })
    return () => { gone = true; report(k, null); if (url) URL.revokeObjectURL(url) }
  }, [k, source, report])
  const name = source.caption(k)
  const title = source.title?.(k) ?? name
  if (shot.state === 'none') return <span className="chat-shot-none" title={title}>{t('그림을 불러오지 못했어요: {name}', { name })}</span>
  if (shot.state === 'loading') return <span className="chat-shot chat-shot-wait" aria-hidden="true" />
  return (
    <button type="button" className="chat-shot" title={title} aria-label={`${t('크게 보기')}: ${name}`}
      onClick={e => open(k, e.currentTarget)}>
      <img src={shot.url} alt="" draggable={false} />
    </button>
  )
}

/** A row's pictures; shown large together (the arrows go through the ones that loaded, in order) */
export const PictureRow: React.FC<{ keys: string[]; source: PictureSource; className?: string }> = ({ keys, source, className = 'chat-shots' }) => {
  const { openImages } = useChatContext()
  const blobs = useRef(new Map<string, Blob>())
  const report = useCallback((k: string, blob: Blob | null) => { if (blob) blobs.current.set(k, blob); else blobs.current.delete(k) }, [])
  const open = useCallback((k: string, from: HTMLElement) => {
    const set = keys.filter(x => blobs.current.has(x))
    // the viewer gets URLs of its own (revoked when it closes): a row's may go while it is open
    openImages?.(set.map(x => ({ url: URL.createObjectURL(blobs.current.get(x)!), caption: source.caption(x) })), Math.max(0, set.indexOf(k)), from, true)
  }, [keys, openImages, source])
  if (!keys.length) return null
  return <div className={className}>{keys.map(k => <Picture key={k} k={k} source={source} report={report} open={open} />)}</div>
}

/** The pictures an item shows, read by the paths it names */
export const Pictures: React.FC<{ paths: string[] }> = ({ paths }) => {
  const { loadPicture } = useChatContext()
  const source = React.useMemo<PictureSource | null>(() => (loadPicture
    ? { load: loadPicture, caption: baseName, title: p => p }
    : null), [loadPicture])
  if (!paths.length || !source) return null
  return <PictureRow keys={paths} source={source} />
}
