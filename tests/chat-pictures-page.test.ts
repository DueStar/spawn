/**
 * src/chat/pictures.ts — the pictures an item shows (a Read of a picture file, the files
 * SendUserFile sent, a picture path in an answer), and the tool input that carries them.
 */
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { picturePaths } from '../src/chat/pictures'

const require = createRequire(import.meta.url)
const { toolInput } = require('../electron/chatItems.cjs')

const tool = (tool: string, input: Record<string, unknown>) => ({ id: 't', order: 0, at: null, kind: 'tool', tool, input, state: 'done' }) as any
const text = (s: string) => ({ id: 'x', order: 0, at: null, kind: 'text', text: s }) as any

describe('picturePaths', () => {
  it('a Read of a picture file (relative or absolute); not of other files', () => {
    expect(picturePaths(tool('Read', { file: 'docs/shot.png' }))).toEqual(['docs/shot.png'])
    expect(picturePaths(tool('Read', { file: 'C:/Users/me/a.JPG' }))).toEqual(['C:/Users/me/a.JPG'])
    expect(picturePaths(tool('Read', { file: 'src/a.ts' }))).toEqual([])
  })
  it('the pictures SendUserFile sent (other files left out)', () => {
    expect(picturePaths(tool('SendUserFile', { files: ['C:\\tmp\\a.png', 'C:\\tmp\\notes.md', '/tmp/b.webp'] }))).toEqual(['C:\\tmp\\a.png', '/tmp/b.webp'])
  })
  it('absolute picture paths in an answer, with spaces after a drive or slash, in backticks; deduped; at most 6', () => {
    const s = 'Saved `C:\\Users\\me\\Temp\\shots\\connect-1100x720.png` and /home/me/x.gif, again C:\\Users\\me\\Temp\\shots\\connect-1100x720.png. Not docs/rel.png.'
    expect(picturePaths(text(s))).toEqual(['C:\\Users\\me\\Temp\\shots\\connect-1100x720.png', '/home/me/x.gif'])
    expect(picturePaths(text(Array.from({ length: 9 }, (_, i) => `/p/${i}.png`).join(' ')))).toHaveLength(6)
  })
  it('anything else shows none', () => {
    expect(picturePaths(tool('Bash', { command: 'ls a.png' }))).toEqual([])
    expect(picturePaths({ id: 'u', kind: 'user', text: '/a.png', images: 0 } as any)).toEqual([])
  })
})

describe('toolInput: SendUserFile keeps the files it sent (paths only, capped)', () => {
  it('its files, at most 6', () => {
    expect(toolInput('SendUserFile', { files: ['C:\\a.png', 3, '/b.png'], caption: 'x' }, '')).toEqual({ files: ['C:\\a.png', '/b.png'] })
    expect(toolInput('SendUserFile', { files: Array.from({ length: 9 }, (_, i) => `/${i}.png`) }, '').files).toHaveLength(6)
    expect(toolInput('SendUserFile', {}, '')).toEqual({})
  })
})
