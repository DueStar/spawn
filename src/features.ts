/**
 * features — the page's side of electron/features.cjs: the same switch, read
 * from the same electron/features.json, so flipping it there flips both.
 *
 * OTHER_TOOLS: AI tools other than Claude Code (Codex CLI, tools added in
 * 설정 › AI 도구). Hidden on 2026-11-13 at the owner's request; set
 * `otherTools` to true in electron/features.json to bring them back. The
 * stored settings (tools, defaultTool) are left as they are, only not used.
 */

import FEATURES from '../electron/features.json'
import type { AiTool } from './desktop'

export const OTHER_TOOLS: boolean = FEATURES.otherTools === true

/**
 * CHAT_VIEW: the chat view of a Claude Code session (Phase 2, a read-only lens),
 * the same switch as electron/features.cjs. Off, the app is release 1.4.0 (no 설정
 * row, no flip). VITE_SPAWN_CHAT_VIEW=1 turns it on for development and the
 * screenshot harness only.
 */
export const CHAT_VIEW: boolean = chatViewFlag(
  typeof window !== 'undefined' ? (window as unknown as { spawn?: { features?: { chatView?: unknown } } }).spawn?.features?.chatView : undefined,
  FEATURES.chatView === true || import.meta.env?.VITE_SPAWN_CHAT_VIEW === '1',
)

/**
 * In the app main's switch decides (the preload asks it at load): a page built with
 * VITE_SPAWN_CHAT_VIEW set never offers what main does not serve. Without an answer (a
 * plain browser, the screenshot harness) the build's own value stands.
 */
export function chatViewFlag(fromMain: unknown, built: boolean): boolean {
  return typeof fromMain === 'boolean' ? fromMain : built
}

/** The chat view is offered: the features.json switch and 설정 › 세션 › 채팅으로 보기 both on */
export function chatViewOn(s: { session: { chatView: boolean } }, flag = CHAT_VIEW): boolean {
  return flag && s.session.chatView === true
}

/** 설정's sections: AI 도구 only while other tools are on */
export function settingsSections<K extends string>(sections: [K, string][], on = OTHER_TOOLS): [K, string][] {
  return on ? sections : sections.filter(([k]) => k !== 'tools')
}

/** The tools a new session may run and the one picked first: Claude Code alone while other tools are off */
export function sessionTools(session: { tools: AiTool[]; defaultTool: string }, on = OTHER_TOOLS): { tools: AiTool[]; defaultTool: string } {
  return on ? { tools: session.tools, defaultTool: session.defaultTool } : { tools: [], defaultTool: 'claude' }
}

/** Codex CLI's usage limits for the usage card: none while other tools are off (Claude's rows only) */
export function shownCodexLimits<T>(limits: T | undefined, on = OTHER_TOOLS): T | undefined {
  return on ? limits : undefined
}
