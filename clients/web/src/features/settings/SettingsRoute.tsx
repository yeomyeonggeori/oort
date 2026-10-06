import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useSession } from "@/app/session";
import { useSurfaceProvidedPredicate } from "@/features/capabilities/useSurfaceProvided";
import { queryClient } from "@/app/queryClient";
import { Card } from "@/design/ui/card";
import { resetSettingsQueries } from "@/app/retryScope";
import { titlebarDragProps } from "@/app/sidebarPane";
import { escapeIsClaimed } from "@/design/ui/escapeLayer";
import { InlineBanner } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { RenderErrorBoundary } from "@/features/common/RenderErrorBoundary";
import { IS_TAURI } from "@/lib/env";
import { UpdateSection } from "@/features/updates/UpdateSection";
import { DevicesSection } from "./DevicesSection";
import { AppearanceSection } from "./AppearanceSection";
import { TerminalSection } from "./TerminalSection";
import { ShortcutsSection } from "./ShortcutsSection";
import { LinkPreviewSection } from "./LinkPreviewSection";
import { InviteSection } from "./InviteSection";
import { NotificationRulesSection } from "./NotificationRulesSection";
import { ProfileSection } from "./ProfileSection";
import { UsageSection } from "./UsageSection";
import { WorkHostSection } from "./WorkHostSection";
import { WorkspaceSection } from "./WorkspaceSection";
import { MemorySettingsSection } from "@/features/memory/MemorySettingsSection";
import { leaveSettings } from "./settingsReturn";
import { aiHubSection } from "@momo/core/features/ai/aiHubModel";
import { AiHubMovedLink } from "@/features/aiHub/AiHubMovedLink";
import { AiLinkSection } from "./AiLinkSection";
import {
  DEFAULT_SETTINGS_SECTION,
  reachableSettingsSections,
  resolveSettingsSection,
  type SettingsSectionId,
  type SettingsSectionMeta,
} from "./settingsNav";
import { SectionTitleHiddenContext } from "./SettingsFields";
import { SettingsNav } from "./shell/SettingsNav";
import { SettingsPageHeader } from "./shell/SettingsPageHeader";
import { SettingsShell } from "./shell/SettingsShell";

// =============================================================================
// 설정 셸 (R-1 §5 / #1867 / #3578 S1): 앱 사이드바·타이틀바를 대체하는 전면 레이아웃.
// 왼쪽은 아이콘 목록(shell/SettingsNav), 최상단은 앱으로 돌아가기, 본문은 떠 있는 판
// (shell/SettingsShell) 안의 페이지 머리 + 기존 섹션 재사용. 합친 페이지는 옛 본문을 이어 붙인다.
//
// Operator gating is answered by the server, not guessed by the client: each
// operator section calls its own GET and swaps in the "서버 운영자에게 문의"
// notice on a 403, so a member who cannot change a setting is told who can
// instead of being handed a form whose save is guaranteed to fail.
// =============================================================================

export function SettingsRoute() {
  const { session, workspaceId } = useSession();
  const navigate = useNavigate();
  // ?section=updates lets the sidebar badge (and a bug report) land on one
  // panel instead of "open 설정 and click the fourth item".
  const [params] = useSearchParams();
  // 걸러진 목록의 정본은 `settingsNav` 다 (R2 M-R2-1). 이 화면이 자기 필터를
  // 들고 있는 동안, 그 목록으로 문을 세울지 정하는 쪽(결과 카드·팔레트)은
  // 원표를 읽고 있었고 그래서 `updates`·`code` 에 문이 섰다.
  const surfaceProvided = useSurfaceProvidedPredicate();
  const sections = useMemo(
    () => reachableSettingsSections(surfaceProvided),
    [surfaceProvided]
  );
  const requested = params.get("section");
  // `?section=`은 별칭(합친 옛 구획)과 AI 허브로 옮겨 간 옛 구획을 풀어서 읽는다
  // (`resolveSettingsSection`, 판정은 거기 한 곳). 목차에 선 것만 도착할 수 있다.
  const requestedResolution = resolveSettingsSection(requested);
  const requestedId =
    requestedResolution.kind === "section" &&
    sections.some((item) => item.id === requestedResolution.id)
      ? requestedResolution.id
      : null;
  const [section, setSection] = useState<SettingsSectionId>(
    () => requestedId ?? DEFAULT_SETTINGS_SECTION
  );
  // #2780: 「실행 호스트」는 호스트 목록이 도착한 뒤에야 목차에 선다. 그 전에
  // `?section=code`로 들어온 사람을 기본 섹션에 둔 채 놓아 두지 않고, 목차가
  // 그 섹션을 받는 순간 한 번 옮긴다. 이미 다른 섹션을 고른 사람은 건드리지 않는다.
  // 반대로 호스트가 사라져 지금 섹션이 목차에서 빠지면 기본 섹션으로 접는다.
  useEffect(() => {
    const reachable = sections.some((item) => item.id === section);
    if (!reachable) {
      setSection(DEFAULT_SETTINGS_SECTION);
      return;
    }
    if (
      section === DEFAULT_SETTINGS_SECTION &&
      requestedId !== null &&
      requestedId !== section
    ) {
      setSection(requestedId);
    }
    // `section`을 의존에 넣으면 사용자가 기본 섹션으로 돌아간 순간 다시 끌려간다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, requestedId]);
  const navRefs = useRef<
    Partial<Record<SettingsSectionId, HTMLButtonElement | null>>
  >({});
  const registerRef = useCallback(
    (id: SettingsSectionId, el: HTMLButtonElement | null) => {
      navRefs.current[id] = el;
    },
    []
  );
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const didEnterFocus = useRef(false);

  const close = useCallback(() => leaveSettings(navigate), [navigate]);

  // 전면 전환 진입 포커스 (#1867 M-4): 현재 섹션 버튼, 없으면 h1.
  useLayoutEffect(() => {
    if (didEnterFocus.current) return;
    didEnterFocus.current = true;
    const target = navRefs.current[section] ?? headingRef.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [section]);

  // 선택 항목이 폰의 한 줄 목록 밖(가로)에 있으면 스크롤로 드러낸다 (#1867 M-1, #3064).
  useEffect(() => {
    navRefs.current[section]?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [section]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // Esc 는 지금 열려 있는 **가장 위 층**의 것이다 (#1205 R2 신규 H).
      //
      // 이 자리의 면제는 원래 `INPUT|TEXTAREA|SELECT` 라는 태그 목록뿐이었고,
      // 그 목록은 "무엇을 잃는가"가 아니라 "무슨 태그인가"를 물었다. 그래서 웹훅
      // 발급 카드(`div[tabindex=-1]`, 서버가 원문을 보관하지 않는 일회성
      // 비밀값)와 폐기 확인 프롬프트가 둘 다 면제 밖이었다 — 실측: 확인이
      // 열려 있어도, 다시 볼 수 없는 값이 떠 있어도 Esc 한 번에 설정 전체가
      // 닫혔다. 태그가 아니라 **층**을 묻는다.
      //
      // 층 쪽은 escapeLayer 의 캡처 리스너가 전파를 끊어 이 리스너가 아예 돌지
      // 않게 하므로, 이 줄은 그 규칙을 판정하는 자리에 적어 두는 것이다. 이 줄이
      // **혼자** 잡는 것은 다이얼로그다: 팔레트가 열린 채 Esc 를 눌러도 지금까지
      // 설정이 닫히지 않은 이유는 포커스가 그 입력 칸에 있어 아래 태그 면제에
      // 걸렸기 때문이고(실측), 포커스가 그 칸을 벗어나면 같은 Esc 가 팔레트와
      // 설정을 함께 닫는다. 안전이 포커스 위치에 얹혀 있을 이유가 없다.
      //
      // 그래서 이 리스너는 **캡처 단계**에 붙는다(아래 addEventListener). 버블에
      // 서는 이미 늦다: Radix 가 자기 Esc 를 처리하고 React 가 그 상태를 동기로
      // 흘려보낸 뒤라 `[role=dialog][data-state=open]` 이 DOM 에서 사라져 있고,
      // 술어는 "열린 다이얼로그 없음"이라고 답한다(실측 — 게이트의 캐럿 밖
      // 팔레트 레인이 이것을 잡는다). 집이 지금까지 쓰던 방법은 다이얼로그마다
      // `onEscapeKeyDown` 에서 `stopPropagation` 을 부르는 것이었는데
      // (PluginSection), 그것은 새 다이얼로그가 생길 때마다 기억해야 하는 규율이다.
      if (escapeIsClaimed(event)) return;
      // 3R M5: provider 키 등 명시 저장형 폼을 입력하던 중의 반사적 Esc가
      // 라우트 이탈로 폼 상태를 날리지 않도록, 편집 중에는 무시한다. 층 규칙이
      // 이것을 대체하지는 않는다 — 편집 중인 폼은 층이 아니고, 층으로 만드는
      // 것은 이 표면들이 각자 정할 일이다.
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      close();
    }
    // 캡처인 이유는 위 주석에 있다. 여기서 먼저 본다고 이 라우트가 Esc 를
    // 가로채는 것은 아니다 — 위 두 관문(층·다이얼로그, 그리고 편집 중인 폼)이
    // 전부 "내 것이 아니다"라고 답할 때만 닫는다. 그리고 escapeLayer 의 캡처
    // 리스너와 등록 순서가 어느 쪽이든 결과가 같다: 그쪽이 먼저면 전파가 끊기고,
    // 이쪽이 먼저면 스택이 비어 있지 않으므로 여기서 물러난다.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [close]);

  // Arrow keys move focus through the nav (↑↓ in the column, ←→ in the phone's one-row
  // list, Home/End to the ends); Enter and Space activate through the native button, so no
  // key handling is duplicated for activation.
  function onNavKeyDown(event: React.KeyboardEvent) {
    const next = event.key === "ArrowDown" || event.key === "ArrowRight";
    const prev = event.key === "ArrowUp" || event.key === "ArrowLeft";
    const home = event.key === "Home";
    const end = event.key === "End";
    if (!next && !prev && !home && !end) return;
    event.preventDefault();
    const ids = sections.map((s) => s.id);
    if (home || end) {
      navRefs.current[ids[home ? 0 : ids.length - 1]]?.focus();
      return;
    }
    const focused = ids.findIndex(
      (id) => navRefs.current[id] === document.activeElement
    );
    const from = focused >= 0 ? focused : ids.indexOf(section);
    const step = next ? 1 : ids.length - 1;
    navRefs.current[ids[(from + step) % ids.length]]?.focus();
  }

  // 두 신호를 함께 읽는다 (`useOffline`). 레일의 `disconnected`는 centrifuge가
  // 재연결을 **포기한** 종단 절단에서만 오기 때문에, 랜선을 뽑고 105초를 기다려도
  // 상태는 `connecting`에 머문다 (useOffline.ts). 그 신호 하나만 보던 이 셸은
  // 그래서 실제로 끊긴 사람에게 배너를 보여주지 못했고, 여기 달린 모든 섹션의
  // 오프라인 문장·비활성 컨트롤이 코드에만 있고 화면에는 없었다 — 설정 표면에서
  // 저장 가능 여부를 판단하는 다른 폼들이 이미 쓰고 있는 공용 답을 쓴다
  // (PR 1203 design review H3: "오프라인 상태가 실물로 도달 불가").
  const offline = useOffline();

  // AIH-8: 앱·웹훅·이벤트 구독·에이전트 자격은 AI 허브 › 외부 연결로 옮겼다. 옛 딥링크
  // (?section=…, 서버 안내·팔레트가 아직 이 주소를 건넨다)는 그 줄 상세로 바꿔 보낸다.
  // `ai`는 목차에서 허브로 가는 링크 행이지만 `?section=ai`는 옛 AI 연결 화면이 그대로
  // 열린다(그 주소를 부르는 게이트·캡처·되돌아옴이 많다. T3가 끝나면 걷는다).
  if (requestedResolution.kind === "ai-hub") {
    return <Navigate to={requestedResolution.path} replace />;
  }

  function onSelect(item: SettingsSectionMeta) {
    if (item.link === "ai-hub") navigate(aiHubSection("accounts").path);
    else setSection(item.id);
  }

  const current = sections.find((item) => item.id === section) ?? sections[0];

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="settings-route">
      {IS_TAURI ? (
        <div
          className="wide-only h-control-lg shrink-0"
          aria-hidden="true"
          data-testid="settings-drag-region"
          {...titlebarDragProps(true)}
        />
      ) : null}

      {/* 오프라인 배너는 페이지 위 한 줄이다. 옛 AI 연결 화면은 자기 배너를 들었으나
          (#2877) 그 화면은 AI 허브로 옮겼다. */}
      {offline && (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겼어요. 저장은 다시 연결된 뒤에 할 수 있어요."
          testId="settings-offline-banner"
        />
      )}

      {/* 폰에서는 두 열이 되지 못한다 (goal B6): 240px 섹션 목록이 390px 화면의
          본문을 밀어내므로, 그 폭에서는 목록이 본문 **위의 한 줄**로 눕고(#3064),
          본문이 남은 높이를 전부 받는다 (tokens.css settings-layout / settings-nav). */}
      <SettingsShell
        wide={section === "ai"}
        nav={
          <SettingsNav
            sections={sections}
            current={section}
            onSelect={onSelect}
            onBack={close}
            onKeyDown={onNavKeyDown}
            registerRef={registerRef}
          />
        }
      >
        <SettingsPageHeader
          ref={headingRef}
          title={current.label}
          scope={current.scope}
        />
        <RenderErrorBoundary
          key={section}
          padded={false}
          title="이 설정을 열지 못했어요"
          message="서버에서 받은 설정을 읽지 못했어요."
          retryLabel="다시 시도"
          // Remounting alone re-reads the same cache — `staleTime` is 30s, so
          // within that window nothing is even refetched and the section
          // throws again on the same data. The action has to change the
          // inputs to mean anything, so the cache goes first.
          onRetry={() => resetSettingsQueries(queryClient)}
        >
          {/* 옛 섹션 본문은 아직 카드 문법으로 다시 짜이지 않았다(S3~S5; 프로필은 S2가 끝냈다). 판(`--sheet`) 위에
              맨바닥으로 놓으면 보조 알약(`surface-muted`)이 판에 묻혀 보이지 않으므로(대비
              1.01), 본문 전체를 카드 한 장(`--surface`)에 얹는다. 페이지를 이식하는 슬라이스가
              그 페이지의 이 껍질을 걷고 `SettingsSection` 카드로 바꾼다. 옛 AI 연결 화면은
              자기 판(곁판 포함)을 가져서 껍질과 폭 제한 없이 그대로 둔다. */}
          {section === "ai" || section === "profile" ? (
            <SectionPage
              section={section}
              offline={offline}
              workspaceId={workspaceId}
              memberId={session.member.id}
            />
          ) : (
            <Card
              className="flex min-w-0 flex-col gap-8 p-6"
              data-testid="settings-legacy-card"
            >
              <SectionPage
                section={section}
                offline={offline}
                workspaceId={workspaceId}
                memberId={session.member.id}
              />
            </Card>
          )}
        </RenderErrorBoundary>
      </SettingsShell>
    </div>
  );
}

/**
 * 한 페이지의 본문. 페이지 머리(h1)가 제목을 이미 말하므로 첫 본문은 자기 제목(h2)을
 * 접고 설명 줄만 남긴다(`SectionTitleHiddenContext`). 합친 페이지는 옛 구획 본문을 그
 * 아래에 **제 제목을 단 채** 잇는다: 링크 미리보기·터미널은 S3·S5가 카드로 다시 짜면서
 * 흡수한다. 프로필은 S2가 카드로 다시 짜서 계정을 흡수했다(껍질 없이 제 카드를 든다).
 */
function SectionPage({
  section,
  offline,
  workspaceId,
  memberId,
}: {
  section: SettingsSectionId;
  offline: boolean;
  workspaceId: string;
  memberId: string;
}) {
  const primary = (node: ReactNode) => (
    <SectionTitleHiddenContext.Provider value={true}>{node}</SectionTitleHiddenContext.Provider>
  );
  switch (section) {
    case "profile":
      return <ProfileSection offline={offline} />;
    case "appearance":
      return (
        <>
          {primary(<AppearanceSection />)}
          <LinkPreviewSection />
        </>
      );
    case "notifications":
      return primary(<NotificationRulesSection offline={offline} />);
    case "shortcuts":
      return (
        <>
          {primary(<ShortcutsSection />)}
          <TerminalSection />
        </>
      );
    case "devices":
      return primary(
        <DevicesSection offline={offline} workspaceId={workspaceId} memberId={memberId} />
      );
    case "workspace":
      return primary(<WorkspaceSection workspaceId={workspaceId} offline={offline} />);
    case "members":
      return primary(<InviteSection workspaceId={workspaceId} offline={offline} />);
    case "memory":
      return primary(<MemorySettingsSection workspaceId={workspaceId} offline={offline} />);
    // No `offline` prop: 사용량 is a read, and the realtime rail being down says nothing
    // about whether this GET answers. The panel reads the browser's own offline state
    // instead (react-query fetchStatus), which is the only signal that actually stops
    // the request.
    case "usage":
      return primary(<UsageSection workspaceId={workspaceId} />);
    case "code":
      return primary(
        <WorkHostSection workspaceId={workspaceId} memberId={memberId} offline={offline} />
      );
    case "updates":
      return primary(<UpdateSection />);
    case "ai":
      return (
        <>
          <AiHubMovedLink section="ai" />
          <AiLinkSection offline={offline} workspaceId={workspaceId} />
        </>
      );
    default:
      return null;
  }
}
