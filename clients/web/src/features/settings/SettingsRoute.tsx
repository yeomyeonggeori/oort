import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useSession } from "@/app/session";
import { queryClient } from "@/app/queryClient";
import { resetSettingsQueries } from "@/app/retryScope";
import { titlebarDragProps } from "@/app/sidebarPane";
import { escapeIsClaimed } from "@/design/ui/escapeLayer";
import { cn } from "@/design/lib/cn";
import { InlineBanner } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { RenderErrorBoundary } from "@/features/common/RenderErrorBoundary";
import { IS_TAURI } from "@/lib/env";
import { isDesktop } from "@/lib/tauri";
import { UpdateSection } from "@/features/updates/UpdateSection";
import { AccountSection } from "./AccountSection";
import { AiLinkSection } from "./AiLinkSection";
import { AppearanceSection } from "./AppearanceSection";
import { LinkPreviewSection } from "./LinkPreviewSection";
import { EventSubscriptionSection } from "./EventSubscriptionSection";
import { InviteSection } from "./InviteSection";
import { NotificationRulesSection } from "./NotificationRulesSection";
import { PluginSection } from "@/features/plugins/PluginSection";
import { ProfileSection } from "./ProfileSection";
import { UsageSection } from "./UsageSection";
import { WebhookSection } from "./WebhookSection";
import { WorkHostSection } from "./WorkHostSection";
import { WorkspaceSection } from "./WorkspaceSection";
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "./settingsNav";

// =============================================================================
// 설정 셸 (R-1 §5 / #1867): 앱 사이드바·타이틀바를 대체하는 전면 레이아웃.
// 왼쪽은 섹션 전용 사이드바, 최상단은 앱으로 돌아가기, 본문은 기존 섹션 재사용.
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
  const sections = useMemo(
    () => SETTINGS_SECTIONS.filter((item) => !item.desktopOnly || isDesktop()),
    []
  );
  const requested = params.get("section");
  const [section, setSection] = useState<SettingsSectionId>(() =>
    sections.some((item) => item.id === requested)
      ? (requested as SettingsSectionId)
      : DEFAULT_SETTINGS_SECTION
  );
  const navRefs = useRef<
    Partial<Record<SettingsSectionId, HTMLButtonElement | null>>
  >({});

  const close = useCallback(() => navigate(-1), [navigate]);

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
      if (escapeIsClaimed()) return;
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

  // Arrow keys move focus through the nav; Enter and Space activate through the
  // native button, so no key handling is duplicated for activation.
  function onNavKeyDown(event: React.KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const ids = sections.map((s) => s.id);
    const focused = ids.findIndex(
      (id) => navRefs.current[id] === document.activeElement
    );
    const from = focused >= 0 ? focused : ids.indexOf(section);
    const step = event.key === "ArrowDown" ? 1 : ids.length - 1;
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

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="settings-route">
      <h1 className="sr-only">설정</h1>
      {IS_TAURI ? (
        <div
          className="wide-only h-control-lg shrink-0"
          aria-hidden="true"
          data-testid="settings-drag-region"
          {...titlebarDragProps(true)}
        />
      ) : null}

      {offline && (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겼습니다. 저장은 다시 연결된 뒤에 할 수 있습니다."
          testId="settings-offline-banner"
        />
      )}

      {/* 폰에서는 두 열이 되지 못한다 (goal B6): 240px 섹션 목록이 390px 화면의
          본문을 밀어내므로, 그 폭에서는 목록이 본문 **위로** 올라가고, 본문이
          남은 높이를 전부 받는다 (tokens.css settings-layout / settings-nav). */}
      <div className="settings-layout">
        <nav
          aria-label="설정 섹션"
          onKeyDown={onNavKeyDown}
          className="settings-nav p-2"
          data-testid="settings-nav"
        >
          <div className="pb-3">
            <button
              type="button"
              onClick={close}
              data-testid="settings-back-to-app"
              className="tap-target flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-body hover:bg-surface-hover focus-visible:focus-ring"
            >
              <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
              앱으로 돌아가기
            </button>
          </div>
          {SETTINGS_GROUPS.map((group) => (
            <div key={group} className="flex flex-col gap-1 pb-3">
              <p className="px-2 text-meta text-ink-muted">{group}</p>
              <ul className="flex flex-col gap-1">
                {sections.filter((item) => item.group === group).map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      ref={(el) => {
                        navRefs.current[item.id] = el;
                      }}
                      onClick={() => setSection(item.id)}
                      aria-current={section === item.id ? "page" : undefined}
                      data-testid={`settings-nav-${item.id}`}
                      className={cn(
                        "tap-target w-full rounded-sm px-2 py-1 text-left text-body focus-visible:focus-ring",
                        section === item.id
                          ? "bg-accent-soft text-ink"
                          : "hover:bg-surface-hover"
                      )}
                    >
                      {item.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div
          className="min-w-0 flex-1 overflow-y-auto p-6"
          data-settings-scroll-viewport
        >
          <RenderErrorBoundary
            key={section}
            padded={false}
            title="이 설정을 열지 못했습니다"
            message="서버에서 받은 설정을 읽지 못했습니다."
            retryLabel="다시 시도"
            // Remounting alone re-reads the same cache — `staleTime` is 30s, so
            // within that window nothing is even refetched and the section
            // throws again on the same data. The action has to change the
            // inputs to mean anything, so the cache goes first.
            onRetry={() => resetSettingsQueries(queryClient)}
          >
          {section === "profile" && <ProfileSection offline={offline} />}
          {section === "account" && <AccountSection />}
          {section === "appearance" && <AppearanceSection />}
          {section === "link-previews" && <LinkPreviewSection />}
          {section === "notifications" && (
            <NotificationRulesSection offline={offline} />
          )}
          {section === "updates" && <UpdateSection />}
          {section === "ai" && <AiLinkSection offline={offline} />}
          {section === "code" && (
            <WorkHostSection
              workspaceId={workspaceId}
              memberId={session.member.id}
              offline={offline}
            />
          )}
          {section === "workspace" && (
            <WorkspaceSection workspaceId={workspaceId} offline={offline} />
          )}
          {section === "plugins" && <PluginSection offline={offline} />}
          {/* No `offline` prop: 사용량 is a read, and the realtime rail being
              down says nothing about whether this GET answers. The panel reads
              the browser's own offline state instead (react-query fetchStatus),
              which is the only signal that actually stops the request. */}
          {section === "usage" && <UsageSection workspaceId={workspaceId} />}
          {section === "webhooks" && (
            <WebhookSection
              workspaceId={workspaceId}
              memberId={session.member.id}
              offline={offline}
            />
          )}
          {section === "members" && (
            <InviteSection workspaceId={workspaceId} offline={offline} />
          )}
          {section === "events" && (
            <EventSubscriptionSection workspaceId={workspaceId} offline={offline} />
          )}
          </RenderErrorBoundary>
        </div>
      </div>
    </div>
  );
}
