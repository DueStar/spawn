/**
 * The left panel as a window: its sections are divided by full-width hairlines (each card's border-bottom), except
 * that the Pokédex strip and the session list read as one block (no line between them) — until 1.6.2, when the owner
 * asked for a line there too. 업무 모드 has no Pokédex strip, so nothing changes there.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, '..', 'src', 'styles', 'widget-expanded.css'), 'utf8')

describe('the Pokédex strip and the session list', () => {
  it('are divided like the other sections: no rule takes the strip\'s line away', () => {
    expect(css).not.toMatch(/\.w-side \.w-dex[^{]*\{[^}]*border-bottom: 0/)
  })

  it('every card in the window\'s side panel draws the hairline under it', () => {
    expect(css).toMatch(/\.widget\.mode-window \.w-side \.w-card, \.widget\.mode-fullscreen \.w-side \.w-card \{[^}]*border-bottom: 1px solid var\(--line\);/)
  })
})
