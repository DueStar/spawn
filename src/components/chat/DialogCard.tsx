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
import { answerDialog, dialogSig, parseDialog, type Dialog, type DialogKey } from '../../chat/dialog'
import { commandRecent } from '../../chat/slash'
import { boxSegments } from '../../chat/boxTable'
import { CardShell, Exact } from './AnswerSurface'
import { copyText } from './CodeBlock'

const POLL_MS = 400

type KeyFn = (p: { id: string; key: DialogKey | 'text'; text?: string }) => Promise<{ ok: boolean }>

/** The dialog on terminal `id`'s screen now (null: none), read every 400 ms while `on` */
export function useTermDialog(id: string, on: boolean, read: (id: string) => string | null = termText): Dialog | null {
  const [dialog, setDialog] = useState<Dialog | null>(null)
  useEffect(() => {
    if (!on) { setDialog(null); return }
    // (the same reading kept; any change — another dialog with the same options and a new body, two permissions in a
    // row — is a new one, so the card never shows the last dialog's words over the next)
    const look = () => {
      const d = parseDialog(read(id))
      setDialog(cur => (d && cur && dialogSig(cur) === dialogSig(d) ? cur : d))
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
  useEffect(() => { setWords(null); setNote(null); setCopied(null) }, [`${dialog.title}\n${dialog.options.map(o => o.label).join('\n')}`]) // eslint-disable-line react-hooks/exhaustive-deps
  const [copied, setCopied] = useState<string | null>(null)
  // a panel with no Esc line (/remote-control's) that opened right after the composer sent a command: Esc closes it,
  // so 취소 is offered (decided once per panel, by its title: its rows may change while it is open)
  const panelEsc = useRef<{ title: string; ok: boolean } | null>(null)
  if (!panelEsc.current || panelEsc.current.title !== dialog.title) panelEsc.current = { title: dialog.title, ok: !dialog.numbered && commandRecent(id, Date.now()) }
  const esc = dialog.esc || panelEsc.current.ok

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
              {/* (a table the terminal drew: rows and cells again, or its lines in a monospace block: src/chat/boxTable.ts) */}
              {boxSegments(dialog.body).map((s, k) => (s.kind === 'table'
                ? (
                  <div key={k} className="chat-prose chat-card-dtable"><div className="tbl-wrap"><table>
                    <thead><tr>{s.table.head.map((c, i) => <th key={i}><Exact text={c} /></th>)}</tr></thead>
                    <tbody>{s.table.rows.map((r, ri) => <tr key={ri}>{r.map((c, i) => <td key={i}><Exact text={c} /></td>)}</tr>)}</tbody>
                  </table></div></div>
                )
                : s.kind === 'mono'
                  ? <pre key={k} className="chat-card-dpre">{s.lines.join('\n')}</pre>
                  : s.lines.map((l, i) => (l ? <p key={`${k}-${i}`}><Exact text={l} /></p> : <span key={`${k}-${i}`} className="chat-card-dgap" />))))}
            </div>
          )}
          {/* the panel's links, whole (the terminal may have wrapped them), to select or copy */}
          {dialog.links.length > 0 && (
            <div className="chat-card-dlinks">
              {dialog.links.map(u => (
                <div key={u} className="chat-card-dlink">
                  <code><Exact text={u} /></code>
                  <button type="button" className="chat-btn chat-card-btn" onClick={() => { void copyText(u).then(ok => setCopied(ok ? u : '')) }}>
                    {copied === u ? t('복사했어요') : copied === '' ? t('복사하지 못했어요') : t('링크 복사')}
                  </button>
                </div>
              ))}
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
            {esc && <button type="button" className="chat-btn chat-card-btn" disabled={busy} onClick={() => { void cancel() }}>{t('취소')}</button>}
            <span className="chat-card-hint" role="status">{busy ? t('보내는 중…') : note ? t(note) : ''}</span>
          </div>
        </CardShell>
      </div>
    </div>
  )
}

export default DialogCard
