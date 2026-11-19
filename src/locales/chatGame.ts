/**
 * The chat view's words that speak of the game: the turn summary's step count and the wild Pokémon met in
 * the flow. Kept apart from src/locales/chat.ts, whose words can all show in 업무 모드: these are used only by parts
 * drawn outside it (tests/work-mode.test.ts checks where each is used). The Korean text is the key (src/i18n.ts).
 */
const en: Record<string, string> = {
  // the turn summary's steps (src/components/chat/TurnFoot.tsx)
  '{n}걸음': '{n} steps',
  // (the turn summary's count: its own sense, so 도감 and 박스 keep release 1.4.0's words)
  '{n}걸음#chat': '{n} {n|step|steps}',
  '이 턴 동안 {name}{iga} 걸은 걸음': 'Steps {name} took this turn',
  // a wild Pokémon met in the flow (src/components/chat/WildRow.tsx)
  '야생의 {name}{iga} 나타났다': 'A wild {name} appeared',
  '잡았다': 'Caught',
  '놓쳤다': 'Got away',
  '새로 등록': 'New entry',
  '색이 다른': 'Shiny',
}

const ja: Record<string, string> = {
  '{n}걸음': '{n}歩',
  '{n}걸음#chat': '{n}歩',
  '이 턴 동안 {name}{iga} 걸은 걸음': 'このターンに{name}が歩いた歩数',
  '야생의 {name}{iga} 나타났다': '野生の{name}が現れた',
  '잡았다': '捕まえた',
  '놓쳤다': '逃げられた',
  '새로 등록': '新規登録',
  '색이 다른': '色違い',
}

export default { en, ja }
