import { MyToolsPane } from "./tools/MyToolsPane";

/**
 * AI 허브 `/ai/accounts` 구획. 화면 이름은 「내 도구」(ADR-0198 D3, #3568)다. 주소는 옛 입구
 * (⌘K, 채팅 연결 카드, 설정의 한 줄 링크)가 그대로 닿도록 두고 본문만 하네스 카드로 바꿨다.
 */
export function AiAccountsPane() {
  return <MyToolsPane />;
}
