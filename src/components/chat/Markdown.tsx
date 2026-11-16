/**
 * The chat view's markdown (src/chat/markdown.ts) as React elements. Text is
 * always a text node; there is no raw-HTML path. A link is `<a href="#">` whose
 * click hands the address to `onLink` (the page opens it through the app, which
 * allows http/https only); its address is the title. A file path is a chip
 * button that hands the file and line to `onPath`. Tables scroll sideways in
 * their own box.
 */

import React from 'react'
import { blockKeys, type Block, type Inline } from '../../chat/markdown'
import { t } from '../../i18n'
import { CodeBlock } from './CodeBlock'

export interface MarkdownProps {
  blocks: Block[]
  onLink(url: string): void
  onPath(file: string, line?: number, col?: number): void
  /** Drawn after a top-level block, by its stable key (blockKeys): a finished answer's link preview cards (Phase 5) */
  afterBlock?: (block: Block, key: string) => React.ReactNode
}

type Handlers = Pick<MarkdownProps, 'onLink' | 'onPath'>

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
    case 'code': return <CodeBlock key={key} lang={b.lang} text={b.text} />
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

/** The blocks as elements (no wrapper: the caller's .chat-prose holds them); `afterBlock`'s nodes after their block */
export function Markdown({ blocks, onLink, onPath, afterBlock }: MarkdownProps) {
  const h = { onLink, onPath }
  const keys = blockKeys(blocks)
  if (!afterBlock) return <>{blocks.map((b, i) => blockNode(b, keys[i], h))}</>
  return <>{blocks.map((b, i) => <React.Fragment key={keys[i]}>{blockNode(b, keys[i], h)}{afterBlock(b, keys[i])}</React.Fragment>)}</>
}

export default Markdown
