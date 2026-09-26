import { useQuery } from "@tanstack/react-query";
import { fetchWorkspace } from "@momo/core/features/settings/api";
import {
  SUBSCRIPTION_ENTRY_ACTION,
  subscriptionSurface,
  type SubscriptionSurface,
} from "@momo/core/features/onboarding/aiConnect";
import { useSession } from "@/app/session";
import { Button } from "@/design/ui/button";
import { IS_TAURI, SUBSCRIPTION_AGENTS_BUILD_FLAG } from "@/lib/env";
import { canCreateAgentNow } from "@/features/agentHub/createModel";
import {
  memberFor,
  useDirectory,
  workspaceIdentityKey,
} from "@/features/workspace/useWorkspace";
import { openAiConnectReentry, type AiConnectReentryFrom } from "./aiConnectReentry";

// =============================================================================
// 구독 줄 재진입 입구 (#2870, RCA 1-b·1-c).
//
// 설정 › AI 연결의 「내 계정」 절(#2877, `AiMyAccountsSection`)과 에이전트 화면
// 머리에 선다. 누르면 온보딩의 AI 연결
// 화면을 재진입 모드로 다시 연다(FirstAgentStage `mode="reentry"`).
//
// 누구에게 서는가: 구독 합류는 호스티드 연결을 만든다. 서버는 그 요청에
// 워크스페이스 owner·admin을 요구한다(hosted_agent_connections.rs
// `require_admin`). 그래서 입구도 에이전트 만들기와 같은 판정(`canCreateAgentNow`)
// 뒤에 있다. provider 연결 운영자 판정(PLATFORM_ADMIN_EMAILS)과는 별개라, 설정
// › AI 연결이 운영자 안내로 막혀도 이 블록은 선다.
//
// 무엇을 그리는가: 온보딩과 같은 세 게이트(`subscriptionSurface`).
// - rows: 행동 버튼
// - desktop-only·server-off: 이유 한 줄(버튼 없음. 눌러서 갈 화면에 구독 줄이 없다)
// - hidden(빌드가 구독 표면을 걷음): 아무것도 그리지 않는다
// =============================================================================

/**
 * design 모드 캡처 전용: `?aiEntry=rows|desktop-only|server-off`. 브라우저 캡처는
 * Tauri 셸이 아니라 `rows`를 셸 없이 세울 수 없다. 제품 빌드에서는 늘 null이다.
 */
function readEntrySurfaceOverride(): SubscriptionSurface | null {
  if (import.meta.env.MODE !== "design") return null;
  const hash = window.location.hash;
  const query = hash.includes("?") ? hash.slice(hash.indexOf("?")) : window.location.search;
  const raw = new URLSearchParams(query).get("aiEntry");
  return raw === "rows" || raw === "desktop-only" || raw === "server-off" ? raw : null;
}

/**
 * 입구의 상태. 설정 › AI 연결의 「내 계정」 절(#2877)은 로딩·권한 없음·빌드가
 * 걷음을 서로 다르게 그려야 해서 넷을 가른다.
 *
 * - `pending`: 명부나 서버 값이 아직 오지 않았다(깜빡임 방지로 행동을 세우지 않는다)
 * - `denied`: 합류 권한이 없거나 명부를 읽지 못했다(#2893)
 * - `hidden`: 빌드가 구독 표면을 걷었다
 * - 그 밖: 온보딩과 같은 세 게이트(`subscriptionSurface`)
 */
export type SubscriptionEntryState = "pending" | "denied" | "hidden" | SubscriptionSurface;

export function useSubscriptionEntryState(): SubscriptionEntryState {
  const { workspaceId, session } = useSession();
  const override = readEntrySurfaceOverride();
  const directory = useDirectory(workspaceId);
  const workspace = useQuery({
    queryKey: workspaceIdentityKey(workspaceId),
    queryFn: () => fetchWorkspace(workspaceId),
    retry: false,
    enabled: override === null && SUBSCRIPTION_AGENTS_BUILD_FLAG,
  });
  if (directory.isPending) return "pending";
  // 명부 조회가 실패하면 내 역할을 모른다. `canCreateAgent`는 역할이 없을 때
  // 문을 열어 두므로(명부 밖 사람 가정), 실패를 「정착」으로 넘기면 일반 멤버에게도
  // 입구가 서고 누르면 서버가 403으로 막는다(#2893). 실패는 정착이 아니다.
  const mayJoin = canCreateAgentNow(
    !directory.isError,
    session.member.kind,
    memberFor(directory.directory, session.member.id)?.role
  );
  if (!mayJoin) return "denied";
  if (override !== null) return override;
  if (!SUBSCRIPTION_AGENTS_BUILD_FLAG) return "hidden";
  // 서버 값을 못 읽으면 온보딩과 같이 server-off로 읽는다(버튼 없이 이유 한 줄).
  if (IS_TAURI && workspace.isPending) return "pending";
  return subscriptionSurface({
    isDesktop: IS_TAURI,
    buildFlag: SUBSCRIPTION_AGENTS_BUILD_FLAG,
    serverEnabled: workspace.data ? workspace.data.subscriptionAgentsEnabled : null,
  });
}

/** 에이전트 화면 머리 버튼. 구독 줄이 설 때만 선다(이유 문장은 설정이 진다). */
export function SubscriptionAgentEntryButton({ from }: { from: AiConnectReentryFrom }) {
  if (useSubscriptionEntryState() !== "rows") return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="tap-target"
      onClick={() => openAiConnectReentry(from)}
      data-testid="agent-hub-subscription-entry"
    >
      {SUBSCRIPTION_ENTRY_ACTION}
    </Button>
  );
}
