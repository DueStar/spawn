/**
 * What a tool row in the chat view says (Phase 2): its icon, its label (a Korean key,
 * translated where it is drawn), the detail beside it (a file, a pattern, a command's
 * description …) and the quiet words on its right (running, waiting on the terminal,
 * rejected, stopped, how long it took). Every word is neutral, so it can show in
 * 업무 모드 as it is.
 */

import type { ToolItem } from './types'

export type ToolIcon = 'file' | 'search' | 'run' | 'edit' | 'agent' | 'web' | 'todo' | 'question' | 'plan' | 'tool'

export interface ToolLabel {
  icon: ToolIcon
  /** A Korean key (src/locales/chat.ts), or a tool's own name */
  label: string
  vars?: Record<string, string | number>
  detail: string
  /** The detail is code (a path, a pattern, a command): set in the mono face */
  mono: boolean
}

export interface ToolMeta {
  /** A Korean key */
  text: string
  vars?: Record<string, string | number>
  /** A status dot before the words */
  dot?: 'green' | 'amber'
  /** Answered in the terminal: the row offers 터미널로 보기 */
  terminal?: boolean
}

/** Every string a tool row, a group or a diff can show (for the translation test) */
export const TOOL_TEXT = [
  '파일 읽음', '검색', '파일 찾기', '명령 실행', '명령 실행 실패', '명령을 멈췄어요', '파일 수정', '새 파일', '파일 저장',
  '보조 에이전트', '웹 페이지 읽음', '웹 검색', '할 일 정리', '질문', '계획', '도구', '{server} · {tool}',
  '실행 중', '거절됨', '멈춤', '답함', '터미널에서 답해 주세요', '질문 · 터미널에서 답해 주세요', '계획 · 터미널에서 답해 주세요',
  '터미널로 보기', '파일 {n}개 읽음', '검색 {n}회', '도구 {n}개', '출력이 길어서 앞부분만 보여요 ({lines}줄)',
  '{n}줄 더 보기', '{n}줄은 터미널에서 보세요', '{n}초', '{m}분 {s}초', '{h}시간 {m}분', '{n}줄', '접기', '실패', '결과',
]

const host = (url: string | undefined) => {
  if (!url) return ''
  try { return new URL(url).host } catch { return '' }
}
const firstLine = (s: string | undefined) => {
  for (const line of (s ?? '').split('\n')) {
    const t = line.replace(/^#+\s*/, '').trim()
    if (t) return t
  }
  return ''
}

export function toolLabel(item: ToolItem): ToolLabel {
  const i = item.input ?? {}
  const name = item.tool
  switch (name) {
    case 'Read': case 'NotebookRead':
      return { icon: 'file', label: '파일 읽음', detail: i.file ?? '', mono: true }
    case 'Grep':
      return { icon: 'search', label: '검색', detail: [i.pattern ? `"${i.pattern}"` : '', i.path ?? ''].filter(Boolean).join(' · '), mono: true }
    case 'Glob':
      return { icon: 'search', label: '파일 찾기', detail: i.pattern ?? '', mono: true }
    case 'Bash': case 'PowerShell': {
      const label = item.state === 'failed' ? '명령 실행 실패' : item.state === 'interrupted' ? '명령을 멈췄어요' : '명령 실행'
      return i.description
        ? { icon: 'run', label, detail: i.description, mono: false }
        : { icon: 'run', label, detail: i.command ?? '', mono: true }
    }
    case 'Edit': case 'MultiEdit':
      return { icon: 'edit', label: '파일 수정', detail: i.file ?? '', mono: true }
    case 'Write':
      return { icon: 'edit', label: item.diff?.kind === 'create' ? '새 파일' : '파일 저장', detail: i.file ?? '', mono: true }
    case 'Agent': case 'Task':
      return { icon: 'agent', label: '보조 에이전트', detail: i.description ?? '', mono: false }
    case 'WebFetch':
      return { icon: 'web', label: '웹 페이지 읽음', detail: host(i.url), mono: false }
    case 'WebSearch':
      return { icon: 'web', label: '웹 검색', detail: i.query ?? '', mono: false }
    case 'TodoWrite':
      return { icon: 'todo', label: '할 일 정리', detail: i.todos ? `${i.todos.done}/${i.todos.total}` : '', mono: false }
    case 'AskUserQuestion':
      return { icon: 'question', label: '질문', detail: i.question ?? '', mono: false }
    case 'ExitPlanMode':
      return { icon: 'plan', label: '계획', detail: firstLine(i.plan), mono: false }
    case null: case undefined:
      return { icon: 'tool', label: '도구', detail: '', mono: false }
    default:
      if (i.server && i.mcpTool) return { icon: 'tool', label: '{server} · {tool}', vars: { server: i.server, tool: i.mcpTool }, detail: '', mono: false }
      return { icon: 'tool', label: name, detail: '', mono: false }
  }
}

/** A time as words: 9초 · 1분 48초 · 1시간 2분 */
export function formatDuration(ms: number): { text: string; vars: Record<string, number> } {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return { text: '{n}초', vars: { n: s } }
  if (s < 3600) return { text: '{m}분 {s}초', vars: { m: Math.floor(s / 60), s: s % 60 } }
  return { text: '{h}시간 {m}분', vars: { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) } }
}

/** The words on a tool row's right, or null for none */
export function toolMeta(item: ToolItem): ToolMeta | null {
  if (item.waiting) {
    const text = item.waiting === 'question' ? '질문 · 터미널에서 답해 주세요' : item.waiting === 'plan' ? '계획 · 터미널에서 답해 주세요' : '터미널에서 답해 주세요'
    return { text, dot: 'amber', terminal: true }
  }
  switch (item.state) {
    case 'running': return { text: '실행 중', dot: 'green' }
    case 'rejected': return { text: '거절됨' }
    // a failed call says so in words too (not by its red alone); a command's label already does
    case 'failed': if (item.tool !== 'Bash' && item.tool !== 'PowerShell') return { text: '실패' }; break
    case 'interrupted': return item.tool === 'Bash' || item.tool === 'PowerShell' ? null : { text: '멈춤' }
    case 'unknown': return null
    default: break
  }
  if (item.tool === 'AskUserQuestion' || item.tool === 'ExitPlanMode') return item.state === 'done' ? { text: '답함' } : null
  if (typeof item.durationMs === 'number' && item.durationMs >= 1000) return formatDuration(item.durationMs)
  return null
}

/** 파일 3개 읽음 · 검색 2회 (`tr` is i18n's t, given so it can be tested per language) */
export function groupLabel(files: number, searches: number, tr: (k: string, v?: Record<string, string | number>) => string): string {
  const parts: string[] = []
  if (files) parts.push(tr('파일 {n}개 읽음', { n: files }))
  if (searches) parts.push(tr('검색 {n}회', { n: searches }))
  return parts.join(' · ')
}
