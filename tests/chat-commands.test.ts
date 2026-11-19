/**
 * The / menu's reader in main (electron/chatCommands.cjs): the project's and the user's commands and
 * skills, and the enabled plugins', from their front matter only; and the host's chat:commands (an armed Claude Code
 * session's own folder, never one the page names).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { listCommands, frontMatter } = require('../electron/chatCommands.cjs')

function put(root: string, rel: string, text: string) {
  const p = join(root, ...rel.split('/'))
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}

function world() {
  const root = mkdtempSync(join(tmpdir(), 'spawn-cmds-'))
  const config = join(root, 'config')
  const cwd = join(root, 'work', 'demo')
  const plugin = join(root, 'plugins', 'superpowers', '7.0.2')
  put(cwd, '.claude/commands/deploy.md', '---\ndescription: Ship the app\nargument-hint: <env>\n---\nDeploy $ARGUMENTS\n')
  put(cwd, '.claude/commands/db/migrate.md', '# Run the migrations\n\nThen report.\n')
  put(cwd, '.claude/skills/review-ui/SKILL.md', '---\nname: review-ui\ndescription: "Review the UI, \\"carefully\\""\n---\n')
  put(config, 'commands/standup.md', '---\ndescription: >\n  Write the standup\n  from git log\n---\nbody')
  put(config, 'commands/deploy.md', '---\ndescription: The user\'s deploy (the project\'s wins)\n---\n')
  put(config, 'skills/hallmark/SKILL.md', '---\nname: hallmark\ndescription: Design skill\nargument-hint: "<prompt> | redesign <path>"\n---\n')
  put(config, 'skills/hidden/SKILL.md', '---\nname: hidden\ndescription: no\nuser-invocable: false\n---\n')
  put(config, 'skills/no-file/README.md', 'not a skill')
  put(plugin, 'skills/brainstorming/SKILL.md', '---\nname: brainstorming\ndescription: Plan first\n---\n')
  put(plugin, 'commands/write-plan.md', '---\ndescription: Write a plan\n---\n')
  put(config, 'plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: {
    'superpowers@official': [{ scope: 'user', installPath: plugin }],
    'broken@official': [{ scope: 'user', installPath: 'relative/path' }],
    'bad name@official': [{ scope: 'user', installPath: plugin }],
  } }))
  return { root, config, cwd }
}

describe('frontMatter', () => {
  it('name, description (quoted, folded), argument-hint; the first line of text after it', () => {
    expect(frontMatter('---\nname: a\ndescription: "say \\"hi\\""\n---\n# Title\n')).toEqual({ fields: { name: 'a', description: 'say "hi"' }, first: 'Title' })
    expect(frontMatter('---\ndescription: |\n  one\n  two\n---\n').fields.description).toBe('one two')
    expect(frontMatter('\uFEFF# Just a heading\r\nbody').first).toBe('Just a heading')
    expect(frontMatter("---\ndescription: 'it''s'\n---\n").fields.description).toBe("it's")
  })
})

describe('listCommands', () => {
  it('the project\'s, the user\'s, then the installed plugins\' (as plugin:name); a skill not for users left out', async () => {
    const { config, cwd } = world()
    const list = await listCommands(cwd, { config })
    const by = Object.fromEntries(list.map((c: { name: string }) => [c.name, c]))
    expect(list.map((c: { name: string }) => c.name)).toEqual(['db:migrate', 'deploy', 'review-ui', 'standup', 'hallmark', 'write-plan'.replace(/^/, 'superpowers:'), 'superpowers:brainstorming'])
    expect(by.deploy).toEqual({ name: 'deploy', desc: 'Ship the app', kind: 'project', hint: '<env>' })
    expect(by['db:migrate']).toMatchObject({ desc: 'Run the migrations', kind: 'project' })
    expect(by['review-ui']).toMatchObject({ desc: 'Review the UI, "carefully"', kind: 'project' })
    expect(by.standup).toMatchObject({ desc: 'Write the standup from git log', kind: 'user' })
    expect(by.hallmark).toMatchObject({ desc: 'Design skill', kind: 'skill', hint: '<prompt> | redesign <path>' })
    expect(by['superpowers:brainstorming']).toMatchObject({ desc: 'Plan first', kind: 'plugin' })
    expect(by.hidden).toBeUndefined()
    // (a plugin with no absolute folder or an odd name: left out)
    expect(list.some((c: { name: string }) => c.name.startsWith('broken:') || c.name.startsWith('bad name:'))).toBe(false)
  })
  it('no folders, a network folder, nothing readable: an empty list, never a throw', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spawn-cmds-empty-'))
    expect(await listCommands(join(root, 'missing'), { config: join(root, 'none') })).toEqual([])
    expect(await listCommands('\\\\server\\share', { config: join(root, 'none') })).toEqual([])
    expect(await listCommands(null, { config: join(root, 'none') })).toEqual([])
  })
  it('CLAUDE_CONFIG_DIR, else ~/.claude', async () => {
    const { config, cwd } = world()
    const viaEnv = await listCommands(cwd, { env: { CLAUDE_CONFIG_DIR: config }, home: '/nowhere' })
    expect(viaEnv.some((c: { name: string }) => c.name === 'hallmark')).toBe(true)
    const viaHome = await listCommands(cwd, { env: {}, home: join(config, '..', 'no-home') })
    expect(viaHome.some((c: { name: string }) => c.name === 'hallmark')).toBe(false)
  })
})

describe('the host: chat:commands', () => {
  it('only for an armed Claude Code session, in its own folder from the terminal list', async () => {
    const { createChatHost } = require('../electron/chatHost.cjs')
    const T1 = '11111111-1111-4111-8111-111111111111'
    const T2 = '22222222-2222-4222-8222-222222222222'
    const list = [{ id: T1, tool: 'claude', status: 'running', chat: 'armed', cwd: 'C:\\work\\demo' }, { id: T2, tool: 'claude', status: 'running', chat: 'unarmed', cwd: 'C:\\work\\demo' }]
    const asked: string[] = []
    const host = createChatHost({
      terminals: { list: () => list, refreshSettings() {}, armedCount: () => 1 },
      send() {}, userDataDir: tmpdir(), claudeVersion: async () => '2.1.325',
      makeWorker: () => ({ on() {}, postMessage() {}, terminate() {} }),
      makeEndpoint: () => ({ listen: async () => ({ port: 1, token: 't' }), setDraining() {}, close: async () => {} }),
      readCommands: async (cwd: string) => { asked.push(cwd); return [{ name: 'deploy', desc: 'Ship', kind: 'project' }] },
    })
    await host.enable()
    expect(await host.commands({ id: T1, cwd: 'C:\\Windows' })).toEqual({ ok: true, commands: [{ name: 'deploy', desc: 'Ship', kind: 'project' }] })
    // (kept a moment: read once)
    await host.commands({ id: T1 })
    expect(asked).toEqual(['C:\\work\\demo'])
    expect(await host.commands({ id: T2 })).toEqual({ ok: false })
    expect(await host.commands({ id: 'nope' })).toEqual({ ok: false })
    host.disable()
    expect(await host.commands({ id: T1 })).toEqual({ ok: false })
  })
})
