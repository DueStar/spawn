import { describe, expect, it } from 'vitest'
import { baseName, mentionsIn, splitMentions } from '../src/chat/mentions'

describe('mentions', () => {
  it('finds @paths at the start and after whitespace', () => {
    expect(mentionsIn('@src/a.ts 봐줘\n그리고 @b.css').map(m => m.path)).toEqual(['src/a.ts', 'b.css'])
  })
  it('an e-mail is not a mention', () => {
    expect(mentionsIn('me@example.com 에게')).toEqual([])
  })
  it('a lone @ or a sentence end after the path', () => {
    expect(mentionsIn('@ 혼자')).toEqual([])
    expect(mentionsIn('여기 @src/a.ts, 저기').map(m => m.path)).toEqual(['src/a.ts'])
  })
  it('splits the text around the files', () => {
    expect(splitMentions('봐 @a/b.ts 이거')).toEqual([
      { kind: 'text', text: '봐 ' }, { kind: 'file', path: 'a/b.ts' }, { kind: 'text', text: ' 이거' },
    ])
    expect(splitMentions('@x.ts.')).toEqual([{ kind: 'file', path: 'x.ts' }, { kind: 'text', text: '.' }])
  })
  it('the base name', () => {
    expect(baseName('src\\chat\\a.ts')).toBe('a.ts')
    expect(baseName('docs/')).toBe('docs')
  })
})

describe('the sent message: files first, then the text', () => {
  it('withRefs puts the badges before the text, and leadingRefs takes them back', async () => {
    const { withRefs, leadingRefs } = await import('../src/chat/mentions')
    const sent = withRefs(['README.md', 'src/a.ts'], '요약해줘')
    expect(sent).toBe('@README.md @src/a.ts 요약해줘')
    expect(leadingRefs(sent)).toEqual({ refs: ['README.md', 'src/a.ts'], body: '요약해줘' })
    expect(leadingRefs(withRefs(['a.ts'], ''))).toEqual({ refs: ['a.ts'], body: '' })
  })
  it('a mention inside the sentence stays in the text', async () => {
    const { leadingRefs } = await import('../src/chat/mentions')
    expect(leadingRefs('이거 @a.ts 봐줘')).toEqual({ refs: [], body: '이거 @a.ts 봐줘' })
  })
})
