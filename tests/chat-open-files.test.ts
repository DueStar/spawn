/**
 * A video, a sound, a picture or a PDF Claude names in the chat opens with a click (2026-11-23: an .mp4 path was
 * plain text, and one sent as a file opened in the editor). Named in prose or in backticks, it is a path chip;
 * clicked, it opens in its default app to be looked at — nothing that runs ever does.
 */
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { parseInline } from '../src/chat/markdown'

const require = createRequire(import.meta.url)
const { chatOpenPlan } = require('../electron/links.cjs')

const at = (f: string) => ['C:', 'Users', 'user', 'work', f].join(String.fromCharCode(92))

describe('a media file named in the chat', () => {
  it('is a path chip in prose: a video, a sound, a picture, a PDF', () => {
    for (const f of ['C:\\Users\\user\\out\\demo.mp4', 'out/clip.webm', './a/b.mov', 'C:/x/song.mp3', 'shots/home.png', 'docs/spec.pdf', 'out/v.mkv', 'snd/a.wav']) {
      const xs = parseInline(`만들었어요: ${f} 확인해 주세요`)
      expect(xs.some(x => x.type === 'path' && x.file === f), f).toBe(true)
    }
  })

  it('is a path chip in backticks too, when the backticks hold a path alone', () => {
    const xs = parseInline('저장했어요: `C:\\Users\\user\\out\\demo.mp4`')
    expect(xs.find(x => x.type === 'path')).toMatchObject({ type: 'path', file: 'C:\\Users\\user\\out\\demo.mp4', code: true })
    // (code that is not a lone path stays code)
    expect(parseInline('`npm run build`').some(x => x.type === 'path')).toBe(false)
    expect(parseInline('`demo.mp4`').some(x => x.type === 'path')).toBe(false)
    // a UNC path in backticks stays code, never a chip
    expect(parseInline('`\\\\host\\share\\a.mp4`').some(x => x.type === 'path')).toBe(false)
  })

  it('opens in its default app (no line); a line still goes to the editor; what runs never opens', () => {
    for (const f of ['demo.mp4', 'a.MOV', 'b.webm', 'c.mkv', 'd.avi', 'e.m4v', 'f.mp3', 'g.wav', 'h.m4a', 'i.ogg', 'j.flac']) {
      expect(chatOpenPlan(at(f), { hasScheme: (s: string) => s === 'vscode', platform: 'win32' }), f).toEqual({ view: at(f) })
    }
    for (const f of ['a.exe', 'a.cmd', 'a.svg', 'a.lnk', 'a.mp4.exe']) {
      expect(chatOpenPlan(at(f), { hasScheme: () => false, platform: 'win32' }), f).toEqual({ folder: at(f) })
    }
  })
})
