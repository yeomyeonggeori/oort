import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import type { RealtimeStatus } from "@/lib/realtime";
import { cn } from "@/design/lib/cn";

// 32px vertical rail (R-1 §1). A vertical workspace icon stack has no
// shadcn/Radix primitive, so it is hand-drawn; the switcher menu itself will
// use DropdownMenu when multi-workspace lands (ADR-0117).

function connectionCopy(status: RealtimeStatus): string {
  if (status === "connected") return "실시간 연결됨";
  if (status === "connecting") return "연결 중";
  return "연결 끊김, 재연결 중";
}

export function WorkspaceRail({
  workspaceName,
  connStatus,
}: {
  workspaceName: string;
  connStatus: RealtimeStatus;
}) {
  const initial = workspaceName.trim().slice(0, 1) || "W";
  return (
    <nav
      aria-label="워크스페이스"
      className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-line bg-surface-sidebar py-2"
    >
      {/* Current workspace: marked by an accent bar, not a background tint. */}
      <span
        className="relative flex size-6 items-center justify-center rounded-sm bg-surface-hover text-meta font-semibold text-ink"
        title={workspaceName}
        data-testid="workspace-current"
      >
        {/* 2R design-review: -left-2(-8px)는 아바타의 레일 인셋(4px)을 초과해
            마커가 뷰포트 밖으로 전량 클리핑됐다(0픽셀 렌더 실측). 레일 왼쪽
            가장자리(x=0)에 앵커한다 — R-1 §1 현재 WS 액센트 바. */}
        <span
          aria-hidden="true"
          className="absolute -left-1 h-4 w-marker rounded-sm bg-accent"
        />
        {initial}
      </span>

      {/* 빈 타일이지 맨 +가 아니다. 채널 섹션 헤더의 "새 채널 만들기"가 같은
          lucide Plus를 같은 size-4, 같은 text-ink-muted로 200px 옆에 세우면서
          접근 이름만 다르고 눈으로는 구별되지 않았다(R2 M8). 이 열은
          워크스페이스 타일이 서는 열이므로 윤곽선을 둘러 "아직 비어 있는
          타일"로 읽히게 한다: 바로 위 현재 워크스페이스 타일과 같은 24px
          사각형이고 채워지지 않았을 뿐이다. 윤곽선은 컨트롤 윤곽선이라
          --line이 아니라 --line-strong(3:1)을 쓴다(tokens.md §2). */}
      <Link
        to="/settings"
        aria-label="워크스페이스 추가"
        title="워크스페이스 추가"
        className="flex size-6 items-center justify-center rounded-sm border border-line-strong text-ink-muted transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <Plus className="size-4" />
      </Link>

      <span className="flex-1" />

      {/* Connection state: bound to the real rail status, never decorative. */}
      <span
        data-testid="conn-status"
        data-status={connStatus}
        title={connectionCopy(connStatus)}
        aria-label={connectionCopy(connStatus)}
        className={cn(
          "size-2 rounded-sm",
          connStatus === "connected" && "bg-ok",
          connStatus === "connecting" && "bg-warn",
          connStatus === "disconnected" && "bg-danger"
        )}
      />
    </nav>
  );
}
