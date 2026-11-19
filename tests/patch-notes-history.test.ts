/** The patch notes history (2026-11-19): every release kept, grouped by minor version; the body scrolls */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { byMinor } from '../src/components/PatchNotes'
import { releasesIn } from '../src/patchNotes'

const md = readFileSync(join(__dirname, '..', 'CHANGELOG.md'), 'utf8')

describe('patch notes history', () => {
  it('groups every release by minor version, newest first, losing none', () => {
    const all = releasesIn(md, 'ko')
    const groups = byMinor(all)
    expect(groups[0].minor).toBe(all[0].version.split('.').slice(0, 2).join('.'))
    expect(groups.flatMap(g => g.releases)).toEqual(all)
    expect(all.length).toBeGreaterThan(60)
  })
  it('the body can shrink and scroll inside the modal (min-height: 0)', () => {
    const css = readFileSync(join(__dirname, '..', 'src', 'styles', 'widget-expanded.css'), 'utf8')
    expect(css).toMatch(/\.w-notes-body \{ flex: 1 1 auto; min-height: 0; overflow-y: auto;/)
  })
})
