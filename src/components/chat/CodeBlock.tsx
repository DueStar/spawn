/**
 * A fenced code block in the chat view: a quiet head with the language and a 복사
 * button, then the text as it is (no colouring in this phase). The text is a React
 * text node, never markup.
 */

import React, { useEffect, useRef, useState } from 'react'
import { t } from '../../i18n'

/** Copy text; true when the clipboard took it */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return false
    await navigator.clipboard.writeText(text)
    return true
  } catch { return false }
}

export type CopyState = 'idle' | 'ok' | 'fail'

/** The button's word: 복사, then 복사했어요 or 복사하지 못했어요 — and for a text that was cut, that its cut part was not copied */
export function copyWord(state: CopyState, cut = false): string {
  if (state === 'ok') return cut ? t('잘린 부분은 복사되지 않았어요') : t('복사했어요')
  return state === 'fail' ? t('복사하지 못했어요') : t('복사')
}

/**
 * A 복사 button that says 복사했어요 (or 복사하지 못했어요) for 1.5 s. `cut`: the text is only the start
 * of what was said (an answer over the lens's cap): once copied it says so, for 3 s.
 */
export const CopyButton: React.FC<{ text: string; label: string; className?: string; cut?: boolean }> = ({ text, label, className, cut = false }) => {
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const copy = async () => {
    const ok = await copyText(text)
    setState(ok ? 'ok' : 'fail')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), ok && cut ? 3000 : 1500)
  }
  const word = copyWord(state, cut)
  return (
    <button type="button" className={`chat-copy${className ? ` ${className}` : ''}`} onClick={copy} aria-label={label} title={label}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></svg>
      <span aria-live="polite">{word}</span>
    </button>
  )
}

export const CodeBlock: React.FC<{ lang: string; text: string }> = ({ lang, text }) => (
  <div className="chat-code">
    <div className="chat-code-head">
      <span className="chat-code-lang">{lang}</span>
      <CopyButton text={text} label={t('코드 복사')} />
    </div>
    <pre><code>{text}</code></pre>
  </div>
)

export default CodeBlock
