import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useSession } from "@/app/session";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import { queryClient } from "@/app/queryClient";
import { resetSettingsQueries } from "@/app/retryScope";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { InlineBanner } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { RenderErrorBoundary } from "@/features/common/RenderErrorBoundary";
import { isDesktop } from "@/lib/tauri";
import { UpdateSection } from "@/features/updates/UpdateSection";
import { AccountSection } from "./AccountSection";
import { AiLinkSection } from "./AiLinkSection";
import { AppearanceSection } from "./AppearanceSection";
import { EventSubscriptionSection } from "./EventSubscriptionSection";
import { InviteSection } from "./InviteSection";
import { PluginSection } from "@/features/plugins/PluginSection";
import { SectionShell } from "./SettingsFields";
import { UsageSection } from "./UsageSection";
import { WorkHostSection } from "./WorkHostSection";
import { WorkspaceSection } from "./WorkspaceSection";

// =============================================================================
// 설정 셸 (R-1 §5): a full-screen route with a left nav and a right panel, not
// a modal. "패널 수는 죄": the operator sections are grouped under one quiet
// heading rather than spread across tabs, and there is no tour.
//
// Operator gating is answered by the server, not guessed by the client: each
// operator section calls its own GET and swaps in the "서버 운영자에게 문의"
// notice on a 403, so a member who cannot change a setting is told who can
// instead of being handed a form whose save is guaranteed to fail.
// =============================================================================

type SectionId =
  | "account"
  | "appearance"
  | "notifications"
  | "updates"
  | "ai"
  | "code"
  | "workspace"
  | "plugins"
  | "events"
  | "usage"
  | "members";

/**
 * The two groups are a SCOPE, not a permission: 나 is what only affects the
 * signed-in member, 워크스페이스 is what the whole tenant shares. Permission is
 * answered per panel by the server (each operator section swaps in the "서버
 * 운영자에게 문의" notice on a 403), so the nav must not double as a gate.
 *
 * The group used to be called 운영, which read as operator-only and put 사용량
 * behind an expectation that is false: every member may read the workspace's
 * costs (AX-7 1층 계약: "워크스페이스에서 발생하는 과금은 사용자가 전부 트래킹").
 * A member who can read a panel should not have to disbelieve the sidebar to
 * open it.
 */
interface SectionMeta {
  id: SectionId;
  label: string;
  group: "나" | "워크스페이스";
  /** Only in the desktop shell: a browser tab has no app bundle to update. */
  desktopOnly?: boolean;
}

const SECTIONS: SectionMeta[] = [
  { id: "account", label: "계정", group: "나" },
  // 테마는 이 기기에만 저장되는 선택이라 워크스페이스가 아니라 나에 속한다
  // (src/design/theme.ts). 계정 바로 아래인 것은 순서가 곧 빈도이기 때문이다.
  { id: "appearance", label: "테마", group: "나" },
  { id: "notifications", label: "알림 규칙", group: "나" },
  { id: "updates", label: "업데이트", group: "나", desktopOnly: true },
  { id: "ai", label: "AI 연결", group: "워크스페이스" },
  { id: "code", label: "코드 실행 호스트", group: "워크스페이스" },
  { id: "workspace", label: "워크스페이스", group: "워크스페이스" },
  { id: "plugins", label: "앱", group: "워크스페이스" },
  { id: "usage", label: "사용량", group: "워크스페이스" },
  { id: "members", label: "멤버와 초대", group: "워크스페이스" },
  // 마지막인 것은 빈도 순서다 (#1202): 한 번 붙이고 나면 다시 열 일이 드물고,
  // 여는 사람은 오너나 관리자뿐이다. 이름이 '외부 전송'이 아니라 '이벤트 구독'인
  // 것은 서버가 그 이름으로 부르기 때문이다 (openapi event-subscriptions).
  { id: "events", label: "이벤트 구독", group: "워크스페이스" },
];

const GROUPS: SectionMeta["group"][] = ["나", "워크스페이스"];

export function SettingsRoute() {
  const { session, workspaceId } = useSession();
  const navigate = useNavigate();
  // ?section=updates lets the sidebar badge (and a bug report) land on one
  // panel instead of "open 설정 and click the fourth item".
  const [params] = useSearchParams();
  const sections = useMemo(
    () => SECTIONS.filter((item) => !item.desktopOnly || isDesktop()),
    []
  );
  const requested = params.get("section");
  const [section, setSection] = useState<SectionId>(() =>
    sections.some((item) => item.id === requested)
      ? (requested as SectionId)
      : "account"
  );
  const navRefs = useRef<Partial<Record<SectionId, HTMLButtonElement | null>>>({});

  const close = useCallback(() => navigate(-1), [navigate]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // 3R M5: provider 키 등 명시 저장형 폼을 입력하던 중의 반사적 Esc가
      // 라우트 이탈로 폼 상태를 날리지 않도록, 편집 중에는 무시한다.
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      close();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarDrawerToggle />
          <h1 className="text-body font-semibold">설정</h1>
        </div>
        <Button variant="ghost" size="sm" onClick={close}>
          닫기
        </Button>
      </header>

      {offline && (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겼습니다. 저장은 다시 연결된 뒤에 할 수 있습니다."
          testId="settings-offline-banner"
        />
      )}

      {/* 폰에서는 두 열이 되지 못한다 (goal B6): 192px 섹션 목록이 390px 화면의
          본문에 198px만 남긴다. 그 폭에서는 목록이 본문 **위로** 올라가고, 본문이
          남은 높이를 전부 받는다 (tokens.css settings-layout / settings-nav). */}
      <div className="settings-layout">
        <nav
          aria-label="설정 섹션"
          onKeyDown={onNavKeyDown}
          className="settings-nav p-2"
        >
          {GROUPS.map((group) => (
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
                      className={cn(
                        "tap-target w-full rounded-sm px-2 py-1 text-left text-body focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
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
          className="min-w-0 flex-1 overflow-y-auto p-4"
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
          {section === "account" && <AccountSection />}
          {section === "appearance" && <AppearanceSection />}
          {section === "notifications" && <NotificationRulesSection />}
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

/**
 * 알림 규칙 (P9): the rule tree lives on the server and has no operator REST
 * yet, so this panel states the contract rather than drawing switches that
 * would write nowhere.
 */
function NotificationRulesSection() {
  return (
    <SectionShell
      title="알림 규칙"
      lines={[
        "알림 규칙은 서버에 하나만 존재합니다. 플랫폼마다 다시 구현하지 않습니다.",
        "각 알림에는 왜 왔는지가 함께 기록되고, 인박스에서 그 이유를 볼 수 있습니다.",
      ]}
    >
      <p className="text-body text-ink-muted">
        규칙을 이 화면에서 바꾸는 기능은 아직 없습니다. 지금은 서버 설정으로만
        바뀝니다.
      </p>
    </SectionShell>
  );
}
