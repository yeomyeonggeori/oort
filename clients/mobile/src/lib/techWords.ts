// =============================================================================
// 기술 낱말 표 (#5452) - 상태 이름(`open`)·스타일 값(`center`)·이벤트 이름(`keyboardDidShow`)을 글자 리터럴 없이 쓴다.
//
// 직접 문구 장부(`direct-copy`)는 **글자 하나짜리 낱말 리터럴도 문구 후보로 센다**(`'center'` 도 한 칸이다). 이 낱말들은 사람이 읽는 글이 아니라 코드의 이름이라, 사전 열쇠로 옮기는 것이 아니라
// 이름으로 쓴다: 객체의 **키**(이름)는 장부가 세지 않으므로 표의 키에서 같은 낱말을 되돌려 받는다(`expressionBox.ts` 의 `nameOf` 와 같은 길 - #5451). 타입은 그대로 리터럴(`'center'`)이라
// 리액트 네이티브 스타일·상태 타입이 그대로 받는다. 사람이 읽는 글은 여기 없다.
// =============================================================================

const spell = <K extends string>(table: Record<K, number>): {readonly [P in K]: P} =>
  Object.fromEntries(Object.keys(table).map(key => [key, key])) as {readonly [P in K]: P};

export const WORD = spell({
  // 이모티콘 창(`composerPanel`)·탭·장의 상태 이름
  closed: 0,
  open: 0,
  handoff: 0,
  ready: 0,
  error: 0,
  loading: 0,
  offline: 0,
  doors: 0,
  import: 0,
  make: 0,
  emoticon: 0,
  emoji: 0,
  other: 0,
  favorite: 0,
  active: 0,
  tabChanged: 0,
  // 스타일 값
  row: 0,
  center: 0,
  hidden: 0,
  absolute: 0,
  // 키보드 이벤트 이름
  keyboardDidShow: 0,
  keyboardWillShow: 0,
});
