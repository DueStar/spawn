/**
 * The dialog card (2026-11-17): a dialog Claude Code draws in the terminal that no hold card covers — a `/model`
 * confirmation, the folder trust, a plan's choices, a permission or a question its hooks could not hold — read from
 * the terminal's screen (src/chat/dialog.ts) and answered here, so nothing of a chat session needs the terminal.
 * Its words are the screen's, exact. An option is a button; one that takes words (Type something, Tell Claude what
 * to change) opens a field first. 취소 is Esc, offered when the dialog says Esc works. The screen is read again
 * every 400 ms while the chat is shown; the card goes when the dialog does.
 */

import React, { useEffect, useRef, useState } from 'react'
import { t } from '../../i18n'
import { termText } from '../../termMetrics'
import { answerDialog, parseDialog, sameDialog, type Dialog, type DialogKey } from '../../chat/dialog'
import { CardShell, Exact } from './AnswerSurface'

const POLL_MS = 400

type KeyFn = (p: { id: string; key: DialogKey | 'text'; text?: string }) => Promise<{ ok: boolean }>

/** The dialog on terminal `id`'s screen now (null: none), read every 400 ms while `on` */
export function useTermDialog(id: string, on: boolean, read: (id: string) => string | null = termText): Dialog | null {
  const [dialog, setDialog] = useState<Dialog | null>(null)
  useEffect(() => {
    if (!on) { setDialog(null); return }
    const look = () => {
      const d = parseDialog(read(id))
      setDialog(cur => (d && cur && sameDialog(cur, d) && cur.selected === d.selected && cur.title === d.title ? cur : d))
    }
    look()
    const timer = setInterval(look, POLL_MS)
    return () => clearInterval(timer)
  }, [id, on, read])
  return dialog
}

export const DialogCard: React.FC<{ id: string; dialog: Dialog; dialogKey: KeyFn; read?: (id: string) => string | null }> = ({ id, dialog, dialogKey, read = termText }) => {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [words, setWords] = useState<{ index: number; text: string } | null>(null)
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => { if (words) field.current?.focus() }, [words?.index]) // eslint-disable-line react-hooks/exhaustive-deps
  // another dialog on the screen: a fresh card
  useEffect(() => { setWords(null); setNote(null) }, [dialog.options.map(o => o.label).join('\n')]) // eslint-disable-line react-hooks/exhaustive-deps

  const deps = {
    read: () => read(id),
    key: async (k: DialogKey) => { try { return (await dialogKey({ id, key: k })).ok } catch { return false } },
    paste: async (text: string) => { try { return (await dialogKey({ id, key: 'text', text })).ok } catch { return false } },
    sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  }
  const pick = async (index: number, text?: string) => {
    if (busy) return
    setBusy(true)
    setNote(null)
    try {
      const r = await answerDialog(index, deps, text)
      if (!r.ok) setNote(r.reason === 'words' ? '입력한 글이 화면에 보이지 않아서 멈췄어요. 다시 해 주세요' : '고르지 못했어요. 화면이 바뀌었을 수 있어요. 다시 눌러 주세요')
      else setWords(null)
    } finally { setBusy(false) }
  }
  const cancel = async () => {
    if (busy) return
    setBusy(true)
    try { await deps.key('esc') } finally { setBusy(false) }
  }

  const label = dialog.title || t('선택')
  return (
    <div className="chat-answer">
      <div className="chat-answer-in">
        <CardShell title={<Exact text={label} />} label={label} kind={t('선택')} className="question dialog">
          {dialog.body.length > 0 && (
            <div className="chat-card-dbody">
              {dialog.body.map((l, i) => (l ? <p key={i}><Exact text={l} /></p> : <span key={i} className="chat-card-dgap" />))}
            </div>
          )}
          <div className="chat-card-opts">
            {dialog.options.map((o, i) => (
              <button key={o.n} type="button" className={`chat-btn chat-card-opt${i === dialog.selected ? ' marked' : ''}${words?.index === i ? ' on' : ''}`}
                disabled={busy} onClick={() => { if (o.free) setWords({ index: i, text: '' }); else void pick(i) }}>
                <span className="chat-card-optlabel"><Exact text={o.label} /></span>
                {o.desc.map((d, j) => <span key={j} className="chat-card-optdesc"><Exact text={d} /></span>)}
              </button>
            ))}
          </div>
          {words && (
            <form className="chat-card-words" onSubmit={e => { e.preventDefault(); if (words.text.trim()) void pick(words.index, words.text) }}>
              <input ref={field} className="chat-card-field" value={words.text} disabled={busy} placeholder={t('여기에 적어 주세요')}
                onChange={e => setWords({ index: words.index, text: e.target.value })}
                onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setWords(null) } }} />
              <button type="submit" className="chat-btn solid chat-card-btn" disabled={busy || !words.text.trim()}>{t('보내기')}</button>
            </form>
          )}
          <div className="chat-card-acts">
            {dialog.esc && <button type="button" className="chat-btn chat-card-btn" disabled={busy} onClick={() => { void cancel() }}>{t('취소')}</button>}
            <span className="chat-card-hint" role="status">{busy ? t('보내는 중…') : note ? t(note) : ''}</span>
          </div>
        </CardShell>
      </div>
    </div>
  )
}

export default DialogCard
