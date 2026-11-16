/**
 * A dim mask for a hand-written screen (tests/fixtures/chat/screens): one mark per UTF-16 code unit of
 * each line, `.` for a normal character, `d` for a dim one, as src/chat/promptRow.ts dimMask builds it
 * from the xterm buffer. `dimRow`: the prompt row's text after its mark is dim, as Claude Code 2.1.325
 * draws a placeholder or a greyed suggestion (`ESC[2mTry "fix lint errors"`); typed text is never dim.
 * `normalAt`: indexes in the prompt row's text (after the mark) kept normal among the dim ones.
 */
export function maskOf(screen: string, dimRow = false, normalAt: number[] = []): string {
  return screen.split('\n').map(line => {
    const m = line.replace(/[\s\S]/g, '.')
    if (!dimRow || !/^[❯>]/.test(line)) return m
    const row = [...m.slice(2).replace(/\./g, 'd')]
    for (const i of normalAt) if (i < row.length) row[i] = '.'
    return m.slice(0, 2) + row.join('')
  }).join('\n')
}
