/**
 * The pictures an item shows in the chat: a Read of a picture file, the files SendUserFile
 * sent, absolute picture paths in an answer. Each is read by main only when the session's
 * items name it (electron/chatPictures.cjs), as written here; a relative Read path is
 * resolved against the session's folder there.
 */
import type { ChatItem } from './types'

const PICTURE = /\.(?:png|jpe?g|gif|webp)$/i
export const MAX_PICTURES = 6
/**
 * A local absolute path (C:\…, C:/…, /…) ending in a picture extension; spaces end it. Never a
 * web address (the drive letter is not part of a word or a scheme: "https://" is not "s:/") and
 * never a network path (\\host\…, //host/…: Windows would connect to the host).
 */
const IN_TEXT = /(?:(?<![\w:/\\.~])[A-Za-z]:[\\/](?![\\/])|(?<![\w.~:/\\])\/(?![\\/]))[^\s`'"<>|*?]*?\.(?:png|jpe?g|gif|webp)(?![\w])/gi

export function picturePaths(item: ChatItem): string[] {
  const out: string[] = []
  const add = (p: unknown) => { if (typeof p === 'string' && PICTURE.test(p) && !out.includes(p) && out.length < MAX_PICTURES) out.push(p) }
  if (item.kind === 'tool') {
    if (item.tool === 'Read') add(item.input.file)
    if (item.tool === 'SendUserFile') for (const f of item.input.files ?? []) add(f)
  } else if (item.kind === 'text') {
    for (const m of item.text.matchAll(IN_TEXT)) add(m[0])
  }
  return out
}
