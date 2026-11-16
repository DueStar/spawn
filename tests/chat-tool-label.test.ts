/**
 * src/chat/toolLabel.ts — what a tool row says: its icon, its label (a Korean key),
 * the detail beside it and the quiet words on its right; and the group's label.
 * Every new string has en and ja, and none names the game (업무 모드).
 */

import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { groupLabel, toolLabel, toolMeta, formatDuration, TOOL_TEXT } from '../src/chat/toolLabel'
import type { ToolItem } from '../src/chat/types'
import DICTS from '../src/locales'
import chat from '../src/locales/chat'
import { GAME_WORDS } from './helpers'
import { linesOf } from './chat-helpers'

const require = createRequire(import.meta.url)
const { createItemBuilder } = require('../electron/chatItems.cjs')
const { quickSkip } = require('../electron/chatSchema.cjs')

const CWD = 'C:\\Users\\user\\work\\demo'
function tools(name: string): Map<string, ToolItem> {
  const b = createItemBuilder({ cwd: CWD })
  const out = new Map<string, ToolItem>()
  for (const { text, offset } of linesOf(name)) {
    if (quickSkip(text)) continue
    let obj
    try { obj = JSON.parse(text) } catch { continue }
    for (const it of b.line(obj, offset)) if (it.kind === 'tool') out.set(it.id, it)
  }
  return out
}
const tr = (lang: 'ko' | 'en' | 'ja') => (k: string, v?: Record<string, string | number>) => {
  const s = lang === 'ko' ? k : DICTS[lang][k] ?? k
  // (the plural forms as src/i18n.ts fill chooses them: {n|file|files})
  return v ? s.replace(/\{(\w+)\|([^|{}]*)\|([^|{}]*)\}/g, (m, n, one, other) => (n in v ? (Number(v[n]) === 1 ? one : other) : m)).replace(/\{(\w+)\}/g, (m, n) => (n in v ? String(v[n]) : m)) : s
}
const item = (tool: string | null, input: ToolItem['input'] = {}, extra: Partial<ToolItem> = {}): ToolItem => ({ id: 'x', order: 1, at: null, kind: 'tool', tool, input, state: 'done', ...extra })

describe('toolLabel, over the fixtures', () => {
  const t = tools('tools.jsonl')

  it('Read: 파일 읽음 · the file, in mono', () => {
    expect(toolLabel(t.get('toolu_fixture01')!)).toEqual({ icon: 'file', label: '파일 읽음', detail: 'src/math.js', mono: true })
  })
  it('Grep: 검색 · "pattern" · path', () => {
    expect(toolLabel(t.get('toolu_fixture02')!)).toEqual({ icon: 'search', label: '검색', detail: '"sub" · src', mono: true })
  })
  it('Glob: 파일 찾기 · the pattern', () => {
    expect(toolLabel(t.get('toolu_fixture03')!)).toEqual({ icon: 'search', label: '파일 찾기', detail: 'src/**/*.js', mono: true })
  })
  it('Bash: 명령 실행 · its description; failed: 명령 실행 실패; stopped: 명령을 멈췄어요', () => {
    expect(toolLabel(t.get('toolu_fixture04')!)).toEqual({ icon: 'run', label: '명령 실행', detail: 'Run node to print 6*7', mono: false })
    expect(toolLabel(t.get('toolu_fixture05')!)).toMatchObject({ icon: 'run', label: '명령 실행 실패' })
    expect(toolLabel({ ...t.get('toolu_fixture04')!, state: 'interrupted' })).toMatchObject({ label: '명령을 멈췄어요' })
    // no description: the command, in mono
    expect(toolLabel(item('PowerShell', { command: 'Get-ChildItem' }))).toEqual({ icon: 'run', label: '명령 실행', detail: 'Get-ChildItem', mono: true })
  })
  it('Edit: 파일 수정 · the file', () => {
    expect(toolLabel(t.get('toolu_fixture07')!)).toEqual({ icon: 'edit', label: '파일 수정', detail: 'src/math.js', mono: true })
    expect(toolLabel(item('MultiEdit', { file: 'a.ts' }))).toMatchObject({ label: '파일 수정' })
  })
  it('Write: 새 파일 when it created the file, else 파일 저장', () => {
    expect(toolLabel(t.get('toolu_fixture08')!)).toEqual({ icon: 'edit', label: '새 파일', detail: 'src/notes.md', mono: true })
    expect(toolLabel(item('Write', { file: 'a.md' }))).toMatchObject({ label: '파일 저장' })
  })
  it('Agent: 보조 에이전트 · its description', () => {
    const a = tools('agent.jsonl').get('toolu_fixture41')!
    expect(toolLabel(a)).toEqual({ icon: 'agent', label: '보조 에이전트', detail: 'Count lines in notes.txt', mono: false })
    expect(toolLabel(item('Task', { description: 'd' }))).toMatchObject({ label: '보조 에이전트' })
  })
  it('AskUserQuestion: 질문 · the question; ExitPlanMode: 계획 · its first line', () => {
    const ap = tools('ask-plan.jsonl')
    expect(toolLabel(ap.get('toolu_fixture51')!)).toEqual({ icon: 'question', label: '질문', detail: 'Should README.md be updated too?', mono: false })
    expect(toolLabel(ap.get('toolu_fixture53')!)).toEqual({ icon: 'plan', label: '계획', detail: 'Plan: rename notes.txt to notes.md', mono: false })
  })
  it('WebFetch: 웹 페이지 읽음 · the host; WebSearch: 웹 검색 · the query', () => {
    expect(toolLabel(item('WebFetch', { url: 'https://developer.mozilla.org/en-US/docs/x' }))).toEqual({ icon: 'web', label: '웹 페이지 읽음', detail: 'developer.mozilla.org', mono: false })
    expect(toolLabel(item('WebFetch', { url: 'not a url' }))).toMatchObject({ detail: '' })
    expect(toolLabel(item('WebSearch', { query: 'rust lifetimes' }))).toEqual({ icon: 'web', label: '웹 검색', detail: 'rust lifetimes', mono: false })
  })
  it('TodoWrite: 할 일 정리 · done/total', () => {
    expect(toolLabel(item('TodoWrite', { todos: { done: 3, total: 5 } }))).toEqual({ icon: 'todo', label: '할 일 정리', detail: '3/5', mono: false })
  })
  it('an MCP tool: {server} · {tool}; anything else: its name as it is; an unknown call: 도구', () => {
    expect(toolLabel(item('mcp__github__create_issue', { server: 'github', mcpTool: 'create_issue' }))).toEqual({ icon: 'tool', label: '{server} · {tool}', vars: { server: 'github', tool: 'create_issue' }, detail: '', mono: false })
    expect(toolLabel(item('NotebookEdit', { file: 'a.ipynb' }))).toMatchObject({ icon: 'tool', label: 'NotebookEdit', detail: '' })
    expect(toolLabel(item(null))).toMatchObject({ icon: 'tool', label: '도구' })
  })
})

describe('toolMeta: the words on the right', () => {
  it('rejected → 거절됨, interrupted → 멈춤, unknown → nothing, a long run → its time', () => {
    expect(toolMeta(item('Read', {}, { state: 'rejected' }))).toEqual({ text: '거절됨' })
    expect(toolMeta(item('Read', {}, { state: 'interrupted' }))).toEqual({ text: '멈춤' })
    expect(toolMeta(item('Read', {}, { state: 'unknown' }))).toBeNull()
    expect(toolMeta(item('Read', {}, { state: 'done', durationMs: 400 }))).toBeNull()
    expect(toolMeta(item('Read', {}, { state: 'done', durationMs: 12_300 }))).toEqual({ text: '{n}초', vars: { n: 12 } })
    expect(toolMeta(item('Bash', {}, { state: 'running' }))).toEqual({ text: '실행 중', dot: 'green' })
    expect(toolMeta(item('Bash', {}, { state: 'running', waiting: 'permission' }))).toEqual({ text: '터미널에서 답해 주세요', dot: 'amber', terminal: true })
    expect(toolMeta(item('AskUserQuestion', {}, { state: 'running', waiting: 'question' }))).toEqual({ text: '질문 · 터미널에서 답해 주세요', dot: 'amber', terminal: true })
    expect(toolMeta(item('ExitPlanMode', {}, { state: 'running', waiting: 'plan' }))).toEqual({ text: '계획 · 터미널에서 답해 주세요', dot: 'amber', terminal: true })
    expect(toolMeta(item('AskUserQuestion', {}, { state: 'done' }))).toEqual({ text: '답함' })
  })

  it('formatDuration: seconds, then minutes and seconds, then hours and minutes', () => {
    expect(formatDuration(9_400)).toEqual({ text: '{n}초', vars: { n: 9 } })
    expect(formatDuration(108_000)).toEqual({ text: '{m}분 {s}초', vars: { m: 1, s: 48 } })
    expect(formatDuration(3_720_000)).toEqual({ text: '{h}시간 {m}분', vars: { h: 1, m: 2 } })
  })
})

describe('groupLabel', () => {
  it('파일 3개 읽음 · 검색 2회, in ko / en / ja', () => {
    expect(groupLabel(3, 2, tr('ko'))).toBe('파일 3개 읽음 · 검색 2회')
    expect(groupLabel(3, 2, tr('en'))).toBe('Read 3 files · 2 searches')
    expect(groupLabel(3, 2, tr('ja'))).toBe('3個のファイルを読み込み · 検索 2回')
    expect(groupLabel(2, 0, tr('ko'))).toBe('파일 2개 읽음')
    expect(groupLabel(0, 4, tr('en'))).toBe('4 searches')
  })
})

describe('the words', () => {
  it('every key of the chat locale has en and ja, and the other way round', () => {
    expect(Object.keys(chat.en).sort()).toEqual(Object.keys(chat.ja).sort())
    for (const k of Object.keys(chat.en)) {
      expect(chat.en[k], k).toBeTruthy()
      expect(chat.ja[k], k).toBeTruthy()
    }
  })

  it('every string a tool row can show is translated', () => {
    for (const ko of TOOL_TEXT) {
      expect(DICTS.en[ko], `en: ${ko}`).toBeTruthy()
      expect(DICTS.ja[ko], `ja: ${ko}`).toBeTruthy()
    }
  })

  it('placeholders survive translation', () => {
    for (const ko of Object.keys(chat.en)) {
      // ({iga} is the Korean particle after {name}: Korean only)
      const names = (s: string) => (s.match(/\{\w+\}/g) ?? []).filter(n => n !== '{iga}').sort()
      expect(names(chat.en[ko]), ko).toEqual(names(ko))
      expect(names(chat.ja[ko]), ko).toEqual(names(ko))
    }
  })

  it('none of them names the game, in any language', () => {
    for (const ko of Object.keys(chat.en)) {
      for (const text of [ko, chat.en[ko], chat.ja[ko]]) expect(text, text).not.toMatch(GAME_WORDS)
    }
  })
})
