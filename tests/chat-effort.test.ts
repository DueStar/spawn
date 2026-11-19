/**
 * The effort menu (2026-11-19): the control row offers Claude Code's effort levels next to the model, the
 * composer sends `/effort <level>`, and the level the status line names is shown.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ControlRow, EFFORTS, effortLabel } from '../src/components/chat/ControlRow'

const control = (effort?: string | null) => ({ model: 'Opus 5.5', effort, context: { left: 60, tip: 'tip', label: 'HP' as const }, usage: {} })
const actions = { onModel() {}, onEffort() {}, onMode() {}, modelWhy: null, modeWhy: null, unreachable: new Set<never>(), busy: false }

describe('the effort control', () => {
  it('offers the levels Claude Code takes', () => {
    expect(EFFORTS.map(e => e.level)).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('shows the level the status line names, by its label', () => {
    const html = renderToStaticMarkup(React.createElement(ControlRow, { control: control('high'), mode: null, actions }))
    expect(html).toContain('<b>높음</b>')
    expect(html).toContain('생각 정도 높음')
  })

  it('reads 생각 정도 while the level is not known, and keeps a level it lacks a label for as Claude Code says it', () => {
    expect(renderToStaticMarkup(React.createElement(ControlRow, { control: control(null), mode: null, actions }))).toContain('<b>생각 정도</b>')
    expect(effortLabel('ultra')).toBe('ultra')
  })

  it('shows nothing without a menu and without a level (as before)', () => {
    const html = renderToStaticMarkup(React.createElement(ControlRow, { control: control(null), mode: null }))
    expect(html).not.toContain('생각 정도')
  })

  it('is sent as /effort <level> by the composer, under the model rule (an idle prompt)', () => {
    const composer = readFileSync(join(__dirname, '..', 'src', 'components', 'chat', 'Composer.tsx'), 'utf8')
    expect(composer).toContain('text: `/effort ${level}`')
    expect(composer).toContain('onEffort: e => { void changeEffort(e) }')
  })
})

describe('the update button, downloaded vs one to get (2026-11-19)', () => {
  it('shows a restart arrow and 재시작 once downloaded, the plain down arrow before', () => {
    const w = readFileSync(join(__dirname, '..', 'src', 'Widget.tsx'), 'utf8')
    expect(w).toContain("update.status === 'ready' ? <><RestartIcon size={12} /><span className=\"w-update-word\">{t('재시작')}</span></> : <UpdateIcon size={12} />")
    const css = readFileSync(join(__dirname, '..', 'src', 'styles', 'widget.css'), 'utf8')
    expect(css).toMatch(/\.w-update\.ready \{ width: auto;/)
  })
})

describe('the effort menu while Claude works (2026-11-19)', () => {
  it('stays open to clicks: only a card or an ended session stops it (/effort is immediate)', () => {
    const working = { ...actions, modelWhy: '일이 끝나면 바꿀 수 있어요', effortWhy: null }
    const row = React.createElement(ControlRow, { control: control('high'), mode: null, actions: working })
    const html = renderToStaticMarkup(row)
    // the model button names the reason; the effort button invites a change
    expect(html).toContain('생각 정도 높음 · 눌러서 바꾸기')
    const composer = readFileSync(join(__dirname, '..', 'src', 'components', 'chat', 'Composer.tsx'), 'utf8')
    expect(composer).toMatch(/effortWhy: ended \? '세션이 끝났어요' : status\?\.state === 'waiting'/)
  })
})
