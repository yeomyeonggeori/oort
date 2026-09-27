import type {
  LocalHarnessId,
  LocalHarnessProbe,
} from "@momo/core/features/hostedAgents/detect";
import {
  AI_CONNECT_ROW_COPY,
  AI_CONNECT_SERVER_OFF_NOTE,
  HARNESS_LABEL,
  HARNESS_PILL_LABEL,
  type HarnessPill,
} from "@momo/core/features/onboarding/aiConnect";
import { Button } from "@/design/ui/button";
import { Skeleton } from "@/features/common/States";
import { IS_TAURI } from "@/lib/env";
import { openAiConnectReentry } from "@/features/welcome/aiConnectReentry";
import { useSubscriptionEntryState } from "@/features/welcome/SubscriptionAgentEntry";
import { useLocalHarnessWatch } from "@/features/welcome/useLocalHarnessWatch";
import {
  AiFoot,
  AiLineRow,
  AiLogo,
  AiPill,
  AiSection,
  AiSectionHead,
  type AiPillTone,
} from "./aiAccountsParts";

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
//
// #2938 ①: 이 절은 처음에 상태를 읽지 않고 늘 「아직 연결한 구독이 없어요」를
// 그렸다. 같은 순간 AI 연결 화면은 이 맥의 CLI 상태 명령(#2813)을 물어 「준비됨」을
// 보였다. 이제 이 절도 **같은 감지·같은 판정**(`useLocalHarnessWatch` →
// `harnessPill`)을 쓴다. 설치된 CLI마다 한 줄, 알약 낱말도 AI 연결 화면과 같다.
// 프로필(여러 계정, #2777)은 아직 없으므로 한 CLI = 이 맥의 기본 로그인 한 줄이다.
// =============================================================================

export const MY_ACCOUNTS_HEADING_ID = "ai-my-accounts-title";

const EMPTY_LINE = "아직 연결한 구독이 없어요.";
const EMPTY_DETAIL =
  "Claude나 ChatGPT 구독이 있으면 이 맥의 공식 CLI로 붙일 수 있어요.";
const BROWSER_LINE =
  "구독 계정은 데스크탑 앱에서만 연결하고 볼 수 있어요. 이 브라우저 탭에는 이 맥의 CLI가 없어요.";
const DENIED_DETAIL = "구독 에이전트는 워크스페이스 owner·admin이 붙일 수 있어요.";
const ACCOUNT_DETAIL = "구독 · 이 맥의 공식 CLI 기본 로그인";
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
        <MyAccountRows />
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

const PILL_TONE: Record<HarnessPill, AiPillTone> = {
  ready: "ok",
  login: "warn",
  recheck: "warn",
  checking: "mute",
  install: "mute",
};

/**
 * design 모드 캡처 전용: `?aiProbe=claude-ready`. 브라우저에는 이 맥의 CLI가 없어
 * 감지 결과를 셸 없이 세울 수 없다. 제품 빌드에서는 늘 null이다.
 */
function readProbeFixture(): LocalHarnessProbe[] | null {
  if (import.meta.env.MODE !== "design") return null;
  const hash = window.location.hash;
  const query = hash.includes("?") ? hash.slice(hash.indexOf("?")) : window.location.search;
  if (new URLSearchParams(query).get("aiProbe") !== "claude-ready") return null;
  return [
    { id: "claude", installed: true, auth: "logged_in" },
    { id: "codex", installed: true, auth: "needs_login" },
  ];
}

function MyAccountRows() {
  const fixture = readProbeFixture();
  const harness = useLocalHarnessWatch({
    enabled: true,
    fixture: fixture ? { probes: fixture } : null,
  });
  const addButton = (
    <Button
      type="button"
      size="sm"
      className="tap-target"
      onClick={() => openAiConnectReentry("settings")}
      data-testid="subscription-entry-open"
    >
      구독 추가
    </Button>
  );
  if (harness.probes === null) {
    return <Skeleton ready={false} rows={1} className="py-3" />;
  }
  const installed = harness.probes.filter((probe) => probe.installed);
  if (installed.length === 0) {
    return (
      <>
        <AiLineRow testId="subscription-entry" surface="rows" action={addButton}>
          <span>{EMPTY_LINE}</span>
          <span className="text-meta text-ink-muted" data-testid="subscription-entry-detail">
            {EMPTY_DETAIL}
          </span>
        </AiLineRow>
        <AiFoot>{OWN_ACCOUNT_FOOT}</AiFoot>
      </>
    );
  }
  return (
    <>
      <ul className="flex min-w-0 flex-col" aria-label="이 맥의 구독 CLI">
        {installed.map((probe) => (
          <MyAccountRow key={probe.id} id={probe.id} pill={harness.pill(probe.id)} />
        ))}
      </ul>
      <AiLineRow testId="subscription-entry" surface="rows" action={addButton} last>
        <span className="text-meta text-ink-muted" data-testid="subscription-entry-detail">
          다른 CLI의 구독도 이 맥에서 붙일 수 있어요.
        </span>
      </AiLineRow>
      <AiFoot>{OWN_ACCOUNT_FOOT}</AiFoot>
    </>
  );
}

function MyAccountRow({ id, pill }: { id: LocalHarnessId; pill: HarnessPill }) {
  return (
    <li
      className="flex min-w-0 items-center gap-3 border-b border-line px-2 py-3"
      data-testid={`my-account-${id}`}
      data-pill={pill}
    >
      <AiLogo mark={AI_CONNECT_ROW_COPY[id].mark} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body font-semibold text-ink">{HARNESS_LABEL[id]}</span>
        <span className="truncate text-meta text-ink-muted">{ACCOUNT_DETAIL}</span>
      </div>
      <span className="shrink-0" data-testid={`my-account-${id}-state`}>
        <AiPill tone={PILL_TONE[pill]}>{HARNESS_PILL_LABEL[pill]}</AiPill>
      </span>
      {/* 로그인이 필요한 줄은 알약만으로 끝나지 않는다: AI 연결 화면(재진입)의 그
          줄이 로그인 모달을 연다(design-review M-1). */}
      {(pill === "login" || pill === "recheck") && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="tap-target shrink-0"
          aria-label={`${HARNESS_LABEL[id]} 로그인하러 AI 연결 화면 열기`}
          onClick={() => openAiConnectReentry("settings")}
          data-testid={`my-account-${id}-login`}
        >
          로그인
        </Button>
      )}
    </li>
  );
}
