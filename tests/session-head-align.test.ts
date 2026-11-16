/**
 * The session header's line (src/components/SessionHeader.tsx): 1.6.1 put its words on one baseline (the mono branch
 * sat higher than the folder) with `align-items: baseline`, which starts the row at the top of the head, so the words
 * sat 4–6 px above the centred picture and buttons (measured on the harness's chat-compose shot: the name's ink centre
 * 56.9 against the picture's 63.4 in a 40 px bar). 1.6.2: the head spans the bar and each word's line is the bar's
 * height, so the words sit mid-bar (62.9) and still share one baseline. The markup is unchanged (it is pinned
 * elsewhere: the header with the chat view off equals 1.4.0's).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, '..', 'src', 'styles', 'widget-expanded.css'), 'utf8')

describe('the session header line', () => {
  it('spans the bar and keeps one baseline for its words', () => {
    expect(css).toMatch(/\.w-sess-head \{ display: flex; align-items: baseline; align-self: stretch;/)
  })

  it('its words have the bar\'s line height (less its 1px border), the picture and the controls stay centred', () => {
    expect(css).toContain('.w-sess-head > .w-sess-head-name, .w-sess-head > .w-sess-head-branch, .w-sess-head > .w-sess-head-proj { line-height: calc(var(--sess-bar-h) - 1px); }')
    expect(css).toContain('.w-sess-head > .w-sess-head-pic, .w-sess-head > .w-sess-head-rename, .w-sess-head > .w-chat-tools, .w-sess-head > .w-sess-head-close, .w-sess-head > .w-lens { align-self: center; }')
  })
})
