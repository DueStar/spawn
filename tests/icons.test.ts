/**
 * The icon system (2026-11-17): Phosphor, one weight (bold), drawn at 12 / 14 / 16. Every icon the app and the chat
 * export renders at a step, with the same weight; no icon file draws its own strokes but the window buttons.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import * as App from '../src/components/Icons'
import * as Chat from '../src/components/chat/ChatIcons'

const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')
const size = (html: string) => Number(/width="(\d+)"/.exec(html)?.[1])

describe('the icon system', () => {
  it('sizes snap to 12 / 14 / 16; a picture-sized one stays as asked', () => {
    expect([10, 11, 12, 13, 14, 15, 16, 17, 20].map(App.iconStep)).toEqual([12, 12, 12, 14, 14, 16, 16, 16, 20])
  })
  it('every exported icon renders at a step', () => {
    const icons = [...Object.entries(App), ...Object.entries(Chat)]
      .filter(([k, v]) => /Icon$/.test(k) && typeof v === 'function') as [string, React.FC<{ size?: number }>][]
    expect(icons.length).toBeGreaterThan(40)
    for (const [name, C] of icons) {
      for (const asked of [undefined, 13, 15]) {
        const html = renderToStaticMarkup(React.createElement(C, asked ? { size: asked } : {}))
        expect([12, 14, 16], `${name} at ${asked}`).toContain(size(html))
      }
    }
  })
  it('Phosphor, one weight; only the window buttons draw their own strokes, at 1.5', () => {
    const app = src('src/components/Icons.tsx')
    const chat = src('src/components/chat/ChatIcons.tsx')
    expect(app).toMatch(/export const ICON_WEIGHT = 'bold'/)
    expect(chat).not.toMatch(/strokeWidth/)
    expect([...app.matchAll(/strokeWidth="([\d.]+)"/g)].map(m => m[1])).toEqual(['1.5'])
    expect([...app.matchAll(/<Svg \{\.\.\.p\}>/g)]).toHaveLength(3) // minimize, maximize, restore
    // one module per icon, never the whole set
    for (const f of [app, chat]) expect(f).not.toMatch(/from '@phosphor-icons\/react'$/m)
  })
})
