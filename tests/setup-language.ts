/**
 * The system language every test file starts from: Korean, whatever the machine's own locale.
 *
 * The app's language is 설정 › 앱 › 언어, and its default 'auto' follows the system (src/i18n.ts resolveLang reads
 * navigator.language). Node 21+ has a navigator whose language is the machine's: Korean on a Korean PC, English
 * on the macOS runners. A test that renders with the default settings would then read Korean on one machine and
 * English on another. The suite's expectations are written in Korean (the dictionaries' keys), so the system is
 * pinned to Korean here; a test about English or Japanese sets that language itself (a mocked setting, or
 * vi.stubGlobal('navigator', …)), and vi.unstubAllGlobals() brings back this navigator, still Korean.
 *
 * Registered in vitest.config.ts (setupFiles): it runs in each test file's worker before the file is imported.
 */

const SYSTEM_LANGUAGE = 'ko-KR'

if (typeof navigator !== 'undefined') {
  Object.defineProperty(navigator, 'language', { value: SYSTEM_LANGUAGE, configurable: true })
  Object.defineProperty(navigator, 'languages', { value: [SYSTEM_LANGUAGE], configurable: true })
} else {
  // a Node without its own navigator (before 21): one with the language only
  Object.defineProperty(globalThis, 'navigator', { value: { language: SYSTEM_LANGUAGE, languages: [SYSTEM_LANGUAGE] }, configurable: true, writable: true })
}
