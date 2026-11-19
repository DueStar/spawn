/**
 * The new-version note made actionable, and the 채팅 보기 help in 설정 › 세션.
 *
 * - The note keeps its words and gains 자세히 (aria-expanded): one more line on what is off for such a version (the
 *   buttons' holds) and 설정에서 더 보기, which opens 설정 › 세션 with the help open.
 * - 채팅 보기란? sits under the chat view's two rows (채팅으로 보기, 링크 미리보기), only with the chat view's switch (CHAT_VIEW), closed unless opened from the note;
 *   its five lines in ko / en / ja, none speaking of the game (업무 모드 shows them too).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import settings from '../src/locales/settings'
import chat from '../src/locales/chat'
import { GAME_WORDS } from './helpers'

const ROOT = join(__dirname, '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')

const HELP = [
  '채팅 보기란?',
  '세션은 그대로 터미널에서 돌아가고, 채팅은 같은 세션을 대화로 보여 줘요',
  '보낸 말은 터미널 입력란에 그대로 들어가요. 확실하지 않으면 보내지 않고 알려 줘요',
  '변경 사항은 기록에 남은 수정만 보여 줘요. 명령으로 바꾼 파일은 터미널에서 확인해 주세요',
  '링크 미리보기는 켜야만 가져와요. 가져올 때 그 사이트는 누군가 링크를 열었다는 걸 알 수 있어요',
  '확인하지 않은 Claude Code 버전에서는 버튼이 꺼지고, 이상하면 터미널로 보면 돼요',
]
const NOTE = ['자세히', '이 버전에서는 허락·질문 버튼이 꺼지고 터미널에서 답해요', '설정에서 더 보기']

describe('the 채팅 보기 help (설정 › 세션)', () => {
  it('its five lines and its title in en and ja, none empty, none Korean, no game word in any language', () => {
    for (const k of HELP) {
      expect(GAME_WORDS.test(k), k).toBe(false)
      for (const lang of ['en', 'ja'] as const) {
        const v = settings[lang][k]
        expect(v, `${lang}: ${k}`).toBeTruthy()
        expect(v).not.toBe(k)
        expect(GAME_WORDS.test(v), `${lang}: ${v}`).toBe(false)
      }
    }
  })
  it('SettingsView: the help only behind CHAT_VIEW, under 채팅으로 보기; closed unless 설정 was opened at it', () => {
    const src = read('src', 'components', 'SettingsView.tsx')
    for (const k of HELP.slice(1)) expect(src).toContain(`'${k}'`)
    expect(src).toMatch(/\{CHAT_VIEW && <ChatHelp /)
    expect(src.indexOf('<ChatHelp')).toBeGreaterThan(src.indexOf("t('채팅으로 보기')"))
    expect(src).toMatch(/useState\(at\?\.help === true\)/)
    expect(src).toMatch(/aria-expanded=\{open\}/)
  })
})

describe('the new-version note, actionable', () => {
  it('자세히 (aria-expanded) adds the line on what is off and 설정에서 더 보기; the words in en and ja, no game word', () => {
    for (const k of NOTE) {
      expect(GAME_WORDS.test(k)).toBe(false)
      for (const lang of ['en', 'ja'] as const) {
        expect(chat[lang][k], `${lang}: ${k}`).toBeTruthy()
        expect(GAME_WORDS.test(chat[lang][k])).toBe(false)
      }
    }
    expect(chat.en['이 버전에서는 허락·질문 버튼이 꺼지고 터미널에서 답해요']).toBe('With this version, permission and question buttons are off; answer in the terminal.')
    expect(chat.ja['이 버전에서는 허락·질문 버튼이 꺼지고 터미널에서 답해요']).toBe('このバージョンでは許可・質問ボタンはオフになり、ターミナルで答えます。')
    const view = read('src', 'components', 'ChatView.tsx')
    expect(view).toMatch(/status\?\.note === 'new-version' && <VersionNote version=\{status\.version \?\? null\} onHelp=\{onHelp\} \/>/)
    expect(view).toMatch(/aria-expanded=\{more\}/)
    const widget = read('src', 'Widget.tsx')
    expect(widget).toMatch(/setSettingsAt\(\{ section: 'session', help: true \}\)/)
    expect(widget).toMatch(/onHelp=\{openChatHelp\}/)
  })
})
