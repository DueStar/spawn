/**
 * Markdown documents in the chat: a ```markdown block, and a new .md file's diff, drawn as a document
 * card (prose, 문서 / 원문), not as raw text in a code box.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../src/chat/markdown'
import { Markdown, isMarkdownFile } from '../src/components/chat/Markdown'
import { DiffBlock } from '../src/components/chat/DiffBlock'

const noop = () => {}
const html = (src: string) => renderToStaticMarkup(React.createElement(Markdown, { blocks: parseMarkdown(src), onLink: noop, onPath: noop }))

describe('a markdown block is a document', () => {
  it('drawn as prose in a card', () => {
    const out = html('보세요:\n\n```markdown\n# 제목\n\n- 하나\n- 둘\n```')
    expect(out).toContain('chat-mddoc')
    expect(out).toContain('<h1>제목</h1>')
    expect(out).toContain('<li>하나</li>')
    expect(out).not.toContain('chat-code')
  })
  it('another language stays a code block; a markdown block inside the document too', () => {
    expect(html('```ts\nconst a = 1\n```')).toContain('chat-code')
    const nested = html('```md\n# A\n\n~~~markdown\n# B\n~~~\n```')
    expect(nested.match(/chat-mddoc"/g)).toHaveLength(1)
    expect(nested).toContain('chat-code')
  })
  it('the file test', () => {
    expect(['a.md', 'README.MD', 'x.markdown', 'y.mdx', 'z.ts', 'md'].map(isMarkdownFile)).toEqual([true, true, true, true, false, false])
  })
})

describe('a new .md file\'s diff', () => {
  const item = { id: 't1', order: 1, at: null, kind: 'tool', tool: 'Write', input: { file: 'docs/plan.md' }, state: 'done' } as any
  const diff = (file: string, extra: Record<string, unknown> = {}) => ({
    file, kind: 'create', added: 3, removed: 0, hidden: 0,
    hunks: [{ oldStart: 0, newStart: 1, lines: [{ t: '+', old: null, new: 1, text: '# 계획' }, { t: '+', old: null, new: 2, text: '' }, { t: '+', old: null, new: 3, text: '1. 첫 단계' }] }],
    ...extra,
  }) as any
  it('shows the document, 변경 a click away', () => {
    const out = renderToStaticMarkup(React.createElement(DiffBlock, { item, diff: diff('docs/plan.md') }))
    expect(out).toContain('<h1>계획</h1>')
    expect(out).toContain('chat-mddoc-tabs')
    expect(out).not.toContain('chat-diff-lines')
  })
  it('another file, or a cut one: the diff as before', () => {
    expect(renderToStaticMarkup(React.createElement(DiffBlock, { item, diff: diff('a.ts') }))).toContain('chat-diff-lines')
    expect(renderToStaticMarkup(React.createElement(DiffBlock, { item, diff: diff('a.md', { truncated: true }) }))).toContain('chat-diff-lines')
  })
})
