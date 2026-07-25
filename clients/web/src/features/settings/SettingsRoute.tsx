import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSession } from "@/app/session";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";

// =============================================================================
// 설정 셸 (R-1 §5): full-screen route with a left nav and a right panel, not a
// modal. Only 계정 carries real data in P1; the operator sections state their
// contract so the shape is settled before the forms land.
// =============================================================================

type SectionId = "account" | "notifications" | "ai" | "code" | "workspace" | "members";

const SECTIONS: { id: SectionId; label: string; admin?: boolean }[] = [
  { id: "account", label: "계정" },
  { id: "notifications", label: "알림 규칙" },
  { id: "ai", label: "AI 연결", admin: true },
  { id: "code", label: "코드 실행", admin: true },
  { id: "workspace", label: "워크스페이스", admin: true },
  { id: "members", label: "멤버와 초대", admin: true },
];

const COPY: Record<SectionId, string[]> = {
  account: [],
  notifications: [
    "알림 규칙은 서버에 하나만 존재합니다. 플랫폼마다 다시 구현하지 않습니다.",
    "각 알림에는 왜 왔는지가 함께 기록됩니다.",
  ],
  ai: [
    "에이전트가 사용할 provider를 워크스페이스 단위로 연결합니다.",
    "키는 이 기기 또는 이 서버에만 저장되며, 서버 간에 옮기지 않습니다.",
  ],
  code: [
    "코드를 실행할 호스트를 페어링하고, 실행 권한을 Supervised와 Full 중에서 고릅니다.",
    "승인 경계는 이 두 모드로만 표현됩니다.",
  ],
  workspace: [
    "워크스페이스 생성과 참여, 이름 변경을 다룹니다.",
    "이름 변경은 오너만 할 수 있습니다.",
  ],
  members: [
    "초대 링크를 발급해 사람을 부릅니다.",
    "에이전트는 담당자와 수신 범위를 정한 뒤 만들어집니다.",
  ],
};

export function SettingsRoute() {
  const { session, workspaceId, logout } = useSession();
  const { directory } = useDirectory(workspaceId);
  const navigate = useNavigate();
  const [section, setSection] = useState<SectionId>("account");

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") navigate(-1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  const me = memberFor(directory, session.member.id);
  const current = SECTIONS.find((s) => s.id === section);

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="settings-route">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
        <h1 className="text-body font-semibold">설정</h1>
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
          닫기
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="설정 섹션"
          className="w-pane-sm shrink-0 border-r border-line p-2"
        >
          <ul className="flex flex-col gap-1">
            {SECTIONS.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setSection(item.id)}
                  aria-current={section === item.id ? "page" : undefined}
                  className={cn(
                    "w-full rounded-sm px-2 py-1 text-left text-body focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
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
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto p-4">
          <h2 className="text-body font-semibold">{current?.label}</h2>

          {/* Label above value, not a fixed label column: a Korean label and a
              full UUID do not share one width without either truncating or an
              off-grid fixed width. */}
          {section === "account" ? (
            <dl className="mt-3 flex flex-col gap-3 text-body">
              <div className="flex flex-col gap-1">
                <dt className="text-meta text-ink-muted">이름</dt>
                <dd>{me?.displayName ?? session.member.displayName}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-meta text-ink-muted">핸들</dt>
                <dd>@{me?.handle ?? session.member.handle}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-meta text-ink-muted">워크스페이스</dt>
                <dd className="break-all font-mono text-meta" data-numeric>
                  {workspaceId}
                </dd>
              </div>
            </dl>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {COPY[section].map((line, index) => (
                <li key={index} className="text-body text-ink-muted">
                  {line}
                </li>
              ))}
            </ul>
          )}

          {section === "account" && (
            <Button
              variant="outline"
              size="sm"
              className="mt-6"
              onClick={logout}
              data-testid="logout"
            >
              로그아웃
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
