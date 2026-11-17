/**
 * The chat view's markdown (src/chat/markdown.ts) as React elements. Text is
 * always a text node; there is no raw-HTML path. A link is `<a href="#">` whose
 * click hands the address to `onLink` (the page opens it through the app, which
 * allows http/https only); its address is the title. A file path is a chip
 * button that hands the file and line to `onPath`. Tables scroll sideways in
 * their own box. A ```markdown block (and a new .md file's diff, DiffBlock.tsx) is a document card (2026-11-17,
 * the owner's call: raw markdown in a code box read badly): drawn as prose with 문서 / 원문 to switch, long ones
 * folded with 전체 보기. One level only: a markdown block inside the document stays a code block.
 */

import React, { useMemo, useState } from 'react'
import { blockKeys, parseMarkdown, type Block, type Inline } from '../../chat/markdown'
import { t } from '../../i18n'
import { CodeBlock, CopyButton } from './CodeBlock'

export interface MarkdownProps {
  blocks: Block[]
  onLink(url: string): void
  onPath(file: string, line?: number, col?: number): void
  /** Drawn after a top-level block, by its stable key (blockKeys): a finished answer's link preview cards (Phase 5) */
  afterBlock?: (block: Block, key: string) => React.ReactNode
}

type Handlers = Pick<MarkdownProps, 'onLink' | 'onPath'> & { depth?: number }

/** A fenced block in these languages is a document, drawn as one */
const MD_LANGS = new Set(['md', 'markdown', 'mdx'])
export const isMarkdownFile = (file: string) => /\.(md|markdown|mdx)$/i.test(file)
/** A document longer than this many lines is folded until 전체 보기 */
const DOC_FOLD_LINES = 24

const FileGlyph = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M4 1.5h5l3.5 3.5v9.5h-8.5z" /><path d="M9 1.5v3.5h3.5" /></svg>
)

function inlineNodes(xs: Inline[], h: Handlers): React.ReactNode[] {
  return xs.map((x, i) => {
    switch (x.type) {
      case 'text': return x.text
      case 'code': return <code key={i}>{x.text}</code>
      case 'strong': return <strong key={i}>{inlineNodes(x.children, h)}</strong>
      case 'em': return <em key={i}>{inlineNodes(x.children, h)}</em>
      case 'del': return <del key={i}>{inlineNodes(x.children, h)}</del>
      case 'br': return <br key={i} />
      case 'link':
      case 'autolink': {
        const href = x.href
        return (
          // (a middle click or a drag of "#" goes nowhere: the address only ever leaves through onLink)
          <a key={i} href="#" title={href} onClick={e => { e.preventDefault(); h.onLink(href) }} onAuxClick={e => e.preventDefault()} draggable={false}>
            {x.type === 'link' ? inlineNodes(x.children, h) : href}
          </a>
        )
      }
      case 'path': {
        const { file, line, col } = x
        return (
          <button key={i} type="button" className="fchip" title={t('코드 편집기에서 열기 (없으면 폴더에서 보기)')} onClick={e => { e.preventDefault(); h.onPath(file, line, col) }}>
            <span className="fchip-in"><FileGlyph />{x.text}</span>
          </button>
        )
      }
      default: return null
    }
  })
}

const ALIGN = { left: 'left', center: 'center', right: 'right' } as const

function blockNode(b: Block, key: number | string, h: Handlers): React.ReactNode {
  switch (b.type) {
    case 'para': return <p key={key}>{inlineNodes(b.inline, h)}</p>
    case 'heading': {
      const Tag = (['h1', 'h2', 'h3', 'h4'] as const)[b.level - 1]
      return <Tag key={key}>{inlineNodes(b.inline, h)}</Tag>
    }
    case 'hr': return <hr key={key} />
    case 'code': return MD_LANGS.has(b.lang.toLowerCase()) && !h.depth
      ? <MdDoc key={key} text={b.text} title={b.lang} onLink={h.onLink} onPath={h.onPath} />
      : <CodeBlock key={key} lang={b.lang} text={b.text} />
    case 'quote': return <blockquote key={key}>{b.blocks.map((x, i) => blockNode(x, i, h))}</blockquote>
    case 'list': {
      const items = b.items.map((item, i) => (
        <li key={i}>
          {item.map((x, j) => (j === 0 && x.type === 'para' ? <React.Fragment key={j}>{inlineNodes(x.inline, h)}</React.Fragment> : blockNode(x, j, h)))}
        </li>
      ))
      return b.ordered ? <ol key={key} start={b.start === 1 ? undefined : b.start}>{items}</ol> : <ul key={key}>{items}</ul>
    }
    case 'table': {
      const style = (i: number) => (b.align[i] ? { textAlign: ALIGN[b.align[i]!] } : undefined)
      return (
        <div key={key} className="tbl-wrap">
          <table>
            <thead><tr>{b.head.map((c, i) => <th key={i} style={style(i)}>{inlineNodes(c, h)}</th>)}</tr></thead>
            <tbody>{b.rows.map((r, ri) => <tr key={ri}>{r.map((c, i) => <td key={i} style={style(i)}>{inlineNodes(c, h)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )
    }
    case 'cut': return <p key={key} className="chat-cut">{t('글이 길어서 앞부분만 보여요. 나머지는 터미널에서 보세요')}</p>
    default: return null
  }
}

/** A document's body: its markdown as prose (or its text as it is), folded when long */
export const MdDocBody: React.FC<{ text: string; raw: boolean; onLink(url: string): void; onPath(file: string, line?: number, col?: number): void }> = ({ text, raw, onLink, onPath }) => {
  const [open, setOpen] = useState(false)
  const blocks = useMemo(() => parseMarkdown(text), [text])
  const long = text.split('\n').length > DOC_FOLD_LINES
  const h = { onLink, onPath, depth: 1 }
  return (
    <>
      <div className={`chat-mddoc-body${long && !open ? ' folded' : ''}`}>
        {raw ? <pre className="chat-mddoc-raw">{text}</pre> : <div className="chat-prose chat-mddoc-prose">{blocks.map((b, i) => blockNode(b, i, h))}</div>}
      </div>
      {long && <button type="button" className="chat-mddoc-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t('접기') : t('전체 보기')}</button>}
    </>
  )
}

/** 문서 / 원문: how a document is shown */
export const DocToggle: React.FC<{ raw: boolean; onRaw(raw: boolean): void; other?: string }> = ({ raw, onRaw, other }) => (
  <span className="chat-mddoc-tabs" role="group" aria-label={t('보기')}>
    <button type="button" aria-pressed={!raw} className={raw ? '' : 'on'} onClick={() => onRaw(false)}>{t('문서')}</button>
    <button type="button" aria-pressed={raw} className={raw ? 'on' : ''} onClick={() => onRaw(true)}>{other ?? t('원문')}</button>
  </span>
)

/** A markdown block as a document card: its head (the language, 문서 / 원문, 복사), then the body */
export const MdDoc: React.FC<{ text: string; title: string; onLink(url: string): void; onPath(file: string, line?: number, col?: number): void }> = ({ text, title, onLink, onPath }) => {
  const [raw, setRaw] = useState(false)
  return (
    <div className="chat-mddoc">
      <div className="chat-mddoc-head">
        <FileGlyph />
        <span className="chat-mddoc-title">{title}</span>
        <DocToggle raw={raw} onRaw={setRaw} />
        <CopyButton text={text} label={t('원문 복사')} />
      </div>
      <MdDocBody text={text} raw={raw} onLink={onLink} onPath={onPath} />
    </div>
  )
}

/** The blocks as elements (no wrapper: the caller's .chat-prose holds them); `afterBlock`'s nodes after their block */
export function Markdown({ blocks, onLink, onPath, afterBlock }: MarkdownProps) {
  const h = { onLink, onPath }
  const keys = blockKeys(blocks)
  if (!afterBlock) return <>{blocks.map((b, i) => blockNode(b, keys[i], h))}</>
  return <>{blocks.map((b, i) => <React.Fragment key={keys[i]}>{blockNode(b, keys[i], h)}{afterBlock(b, keys[i])}</React.Fragment>)}</>
}

export default Markdown
