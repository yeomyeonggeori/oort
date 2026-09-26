import {
  AI_CONNECT_SERVER_OFF_NOTE,
} from "@momo/core/features/onboarding/aiConnect";
import { Button } from "@/design/ui/button";
import { Skeleton } from "@/features/common/States";
import { IS_TAURI } from "@/lib/env";
import { openAiConnectReentry } from "@/features/welcome/aiConnectReentry";
import { useSubscriptionEntryState } from "@/features/welcome/SubscriptionAgentEntry";
import { AiFoot, AiLineRow, AiSection, AiSectionHead } from "./aiAccountsParts";

// =============================================================================
// 설정 › AI 연결 › 내 계정 · 이 맥 (#2877, 시안 §1·§6).
//
// 이 절이 싣는 것은 이 맥의 공식 CLI 구독이다. 프로필 목록(#2777)과 사용량
// 막대(#2781)는 아직 없으므로 지금 설 수 있는 상태는 「비어 있음」뿐이고, 그
// 줄의 행동이 #2870의 재진입(온보딩 AI 연결 화면을 다시 연다)이다. 그래서 #2870
// 블록(`SubscriptionAgentEntryCard`)은 이 절의 빈 줄로 옮겨 왔다.
//
// 브라우저 탭에는 이 맥의 CLI가 없다. 그 탭에서는 이유 한 줄만 둔다(시안 §6
// 「브라우저 탭에서 열었을 때」). 데스크탑 앱을 이 섹션으로 여는 딥링크는 아직
// 없어서 「데스크탑 앱에서 열기」 버튼은 두지 않는다(누르면 아무 일도 없는 버튼).
// =============================================================================

export const MY_ACCOUNTS_HEADING_ID = "ai-my-accounts-title";

const EMPTY_LINE = "아직 연결한 구독이 없어요.";
const EMPTY_DETAIL =
  "Claude나 ChatGPT 구독이 있으면 이 맥의 공식 CLI로 붙일 수 있어요.";
const BROWSER_LINE =
  "구독 계정은 데스크탑 앱에서만 연결하고 볼 수 있어요. 이 브라우저 탭에는 이 맥의 CLI가 없어요.";
const DENIED_DETAIL = "구독 에이전트는 워크스페이스 owner·admin이 붙일 수 있어요.";
const OWN_ACCOUNT_FOOT =
  "본인 계정만 추가하세요. 이 계정은 이 맥에서 나만 씁니다. 팀 에이전트는 이 계정을 쓰지 않습니다.";

export function AiMyAccountsSection() {
  const state = useSubscriptionEntryState();
  // design 캡처의 `?aiEntry=desktop-only`는 브라우저 탭을 흉내 낸다. 그 밖에는
  // 셸 종류가 답한다. 빌드가 구독 표면을 걷었어도 브라우저 탭 사실은 그대로다.
  const browserTab = state === "desktop-only" || (!IS_TAURI && state !== "rows" && state !== "server-off");

  return (
    <AiSection labelledBy={MY_ACCOUNTS_HEADING_ID} testId="ai-my-accounts">
      <AiSectionHead id={MY_ACCOUNTS_HEADING_ID} title="내 계정" scope="이 맥" />
      {state === "pending" && !browserTab ? (
        <Skeleton ready={false} rows={1} className="py-3" />
      ) : browserTab ? (
        <AiLineRow testId="subscription-entry" surface="desktop-only" last>
          <span data-testid="subscription-entry-detail">{BROWSER_LINE}</span>
        </AiLineRow>
      ) : state === "rows" ? (
        <>
          <AiLineRow
            testId="subscription-entry"
            surface="rows"
            action={
              <Button
                type="button"
                size="sm"
                className="tap-target"
                onClick={() => openAiConnectReentry("settings")}
                data-testid="subscription-entry-open"
              >
                구독 추가
              </Button>
            }
          >
            <span>{EMPTY_LINE}</span>
            <span className="text-meta text-ink-muted" data-testid="subscription-entry-detail">
              {EMPTY_DETAIL}
            </span>
          </AiLineRow>
          <AiFoot>{OWN_ACCOUNT_FOOT}</AiFoot>
        </>
      ) : (
        <AiLineRow testId="subscription-entry" surface={state} last>
          <span>{EMPTY_LINE}</span>
          {state === "server-off" && (
            <span className="text-meta text-ink-muted" data-testid="subscription-entry-detail">
              {AI_CONNECT_SERVER_OFF_NOTE}
            </span>
          )}
          {state === "denied" && (
            <span className="text-meta text-ink-muted" data-testid="subscription-entry-detail">
              {DENIED_DETAIL}
            </span>
          )}
        </AiLineRow>
      )}
    </AiSection>
  );
}
