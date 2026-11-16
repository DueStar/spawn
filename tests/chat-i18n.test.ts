/**
 * en / ja completeness of the chat view (Phase 6, Task 6.3):
 *
 * - every Korean literal the chat code hands to t( / tSense( is a key of a locale (chat.ts, chatGame.ts, or an older one)
 * - chat.ts and chatGame.ts: the same keys in en and ja, none empty, none left in Korean (a key with no Hangul, e.g.
 *   'Lv.{n}', may stay as it is)
 * - the placeholders of every entry are its key's (a plural form `{n|one|other}` counts as {n})
 * - a Korean particle variable ({iga}) only in Korean
 * - plural forms: "1 file changed", "3 files changed" (en); Japanese and Korean without forms
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import DICTS from '../src/locales'
import chat from '../src/locales/chat'
import chatGame from '../src/locales/chatGame'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const HANGUL = /[가-힣]/
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
const PARTICLES = ['iga']
const holes = (s: string) => [...new Set([...s.matchAll(/\{(\w+)(?:\|[^|{}]*\|[^|{}]*)?\}/g)].map(m => m[1]))].sort()

/** the chat view's source files */
const FILES = [
  ...readdirSync(join(ROOT, 'src', 'chat')).filter(f => /\.tsx?$/.test(f)).map(f => `src/chat/${f}`),
  ...readdirSync(join(ROOT, 'src', 'components', 'chat')).filter(f => /\.tsx?$/.test(f)).map(f => `src/components/chat/${f}`),
  'src/components/ChatView.tsx',
]

describe('the chat view in en and ja', () => {
  it('every Korean literal handed to t( or tSense( is a key with en and ja', () => {
    const missing: string[] = []
    let seen = 0
    for (const f of FILES) {
      const src = code(read(f))
      for (const m of src.matchAll(/\bt(?:Sense)?\(\s*'((?:[^'\\]|\\.)*)'(?:\s*,\s*'([\w-]+)')?/g)) {
        const key = m[1].replace(/\\'/g, "'")
        if (!HANGUL.test(key)) continue
        seen++
        const sense = /tSense\(/.test(m[0]) && m[2] ? `${key}#${m[2]}` : null
        for (const lang of ['en', 'ja'] as const) {
          if (!(DICTS[lang][key] ?? (sense && DICTS[lang][sense]))) missing.push(`${f}: ${lang} ${key}`)
        }
      }
    }
    expect(seen).toBeGreaterThan(200)
    expect(missing).toEqual([])
  })

  for (const [name, dict] of [['chat.ts', chat], ['chatGame.ts', chatGame]] as const) {
    it(`${name}: the same keys in en and ja, none empty, none left in Korean, the key's placeholders, particles only in Korean`, () => {
      expect(Object.keys(dict.en).sort()).toEqual(Object.keys(dict.ja).sort())
      for (const [lang, d] of [['en', dict.en], ['ja', dict.ja]] as const) {
        for (const [k, v] of Object.entries(d)) {
          expect(v.trim(), `${lang} ${k}`).not.toBe('')
          if (HANGUL.test(k.replace(/#.*$/, ''))) expect(v, `${lang} ${k}`).not.toBe(k)
          expect(HANGUL.test(v), `${lang} ${k} → ${v}`).toBe(false)
          const want = holes(k.replace(/#.*$/, '')).filter(h => !PARTICLES.includes(h))
          expect(holes(v), `${lang} ${k} → ${v}`).toEqual(want)
          for (const p of PARTICLES) expect(v.includes(`{${p}}`), `${lang} ${k}`).toBe(false)
        }
      }
    })
  }

  it('plural forms in en: 1 file / 3 files, and every count of the foot, the panel and the rows', async () => {
    vi.resetModules()
    vi.doMock('../src/settingsStore', async (orig) => {
      const real = await orig<typeof import('../src/settingsStore')>()
      return { ...real, getSettings: () => ({ ...real.getSettings(), app: { ...real.getSettings().app, language: 'en' } }) }
    })
    try {
      const { t, tSense } = await import('../src/i18n')
      expect(t('파일 {n}개 바꿈', { n: 1 })).toBe('1 file changed')
      expect(t('파일 {n}개 바꿈', { n: 3 })).toBe('3 files changed')
      expect(t('도구 {n}회', { n: 1 })).toBe('1 tool call')
      expect(t('도구 {n}회', { n: 0 })).toBe('0 tool calls')
      expect(t('파일 {n}개 · 수정 {m}번', { n: 1, m: 1 })).toBe('1 file · 1 edit')
      expect(t('파일 {n}개 · 수정 {m}번', { n: 2, m: 1 })).toBe('2 files · 1 edit')
      expect(t('파일 {n}개 읽음', { n: 1 })).toBe('Read 1 file')
      expect(t('새 메시지 {n}개', { n: 1 })).toBe('1 new message')
      expect(tSense('{n}걸음', 'chat', { n: 1 })).toBe('1 step')
      expect(tSense('{n}줄', 'chat', { n: 1 })).toBe('1 line')
      // 도감, 박스 and 설정 keep release 1.4.0's words (their own keys, no forms)
      expect(t('{n}걸음', { n: 1 })).toBe('1 steps')
      expect(t('{n}줄', { n: 1 })).toBe('1 lines')
    } finally {
      vi.doUnmock('../src/settingsStore')
      vi.resetModules()
    }
  })
})
