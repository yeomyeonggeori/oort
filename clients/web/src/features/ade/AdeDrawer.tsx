import { useCallback, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { uuidEq } from "@momo/core/lib/api";
import {
  ADE_DRAWER_EMPTY_DETAIL,
  ADE_DRAWER_EMPTY_HEADLINE,
  ADE_STATE_LABEL,
  adeDiffLabel,
  durabilityTone,
  itemDurabilityBadge,
  type AdeItem,
  type AdeState,
} from "@momo/core/features/work/adeControl";
import { elapsedLabel } from "@momo/core/features/agents/workingSignal";
import { cn } from "@/design/lib/cn";
import { useSession } from "@/app/session";
import { CHIP_CLASS } from "@/features/common/chip";
import { EmptyInvite, InlineBanner } from "@/features/common/States";
import { openWorkPanel } from "@/features/agents/workLogStore";
import {
  channelLabel,
  useChannels,
  useDirectory,
} from "@/features/workspace/useWorkspace";
import { restoreDialogOpenerFocus } from "@/design/ui/dialog";
import { useAdeControl } from "./useAdeControl";
import {
  ADE_DRAWER_DOM_ID,
  closeAdeDrawer,
  takeAdeDrawerOpener,
} from "./adeDrawerStore";

// =============================================================================
// 서랍 = 관제 (ADR-0154 D2 의 2층).
//
//   대화 공간   요약 한 줄     무엇이 몇 개
//   **서랍**    세션 카드 목록  무엇이, 어디서, 얼마나, 살아남는지  <- 여기
//   터미널      상세            실제로 무엇을 했는지
//
// 카드는 「확대」된다: 누르면 **기존 표면**이 열리고 서랍은 물러난다. 새 상세
// 화면을 만들지 않은 것이 이 티켓의 규율이다 — 턴은 작업 패널
// (`AgentWorkPanel`, run 단위 진행 스트림)이 이미 그리고, ACP 세션은 작업 세션
// 패널(`WorkPanel`, 관전 터미널)이 이미 그린다. 세 번째 상세를 세우면 같은 run 을
// 두 곳에서 다르게 말하게 된다.
//
// ## 레이아웃을 밀지 않는다
//
// 기하는 tokens.css `ade-drawer` 한 곳에 있다: 절대 위치로 라우트 상자를 덮고,
// 흐름에서 폭도 높이도 가져가지 않는다. 「작성 중」 줄이 컴포저를 26px 밀었던
// 결함(리뷰 H-2)과 같은 종류를 이 층에서 미리 닫는 것이고, 게이트가 여는 전후의
// 좌표를 픽셀로 재서 그것이 실제로 성립하는지 본다.
//
// 덮인 라우트는 `inert` 로 탭 순서에서 함께 빠진다(AppShell). 그래서 이 서랍은
// 모달처럼 행동하지만 스크림이 없다: 스크림은 「이 아래는 지금 못 쓴다」를 색으로
// 말하는 장치인데, 이 서랍은 라우트의 왼쪽 절반만 덮으므로 오른쪽 절반을 어둡게
// 칠하면 못 쓰는 이유를 설명하지 못한 채 화면 전체를 눌러 놓게 된다. 대신 Esc 와
// 닫기 버튼이 있고, 캐럿은 연 컨트롤(요약 줄)로 돌아간다.
// =============================================================================

const STATE_CHIP_CLASS: Readonly<Record<AdeState, string>> = {
  // 실행 중은 「지금 흐르고 있다」 — 작업 세션 패널의 running 과 같은 표지다.
  working: "bg-surface-hover text-warn",
  // 대기만 accent 를 입는다. 이 화면에서 사람을 부르는 유일한 상태이고, 같은
  // 규칙을 작업 세션 패널이 「호스트 연결 끊김」에 이미 쓴다.
  blocked: "bg-accent-soft text-accent",
  idle: "bg-surface-hover text-ink-muted",
};

const DURABILITY_TONE_CLASS = {
  ok: "text-ok",
  muted: "text-ink-muted",
  warn: "text-warn",
} as const;

function AdeCard({
  item,
  channelName,
  nowMs,
  onOpen,
}: {
  item: AdeItem;
  channelName: string;
  nowMs: number;
  onOpen: () => void;
}) {
  const durability = itemDurabilityBadge(item);
  const diff = adeDiffLabel(item.diff);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-testid="ade-card"
        data-kind={item.kind}
        data-state={item.state}
        data-durability={item.durability}
        className={cn(
          "flex w-full min-w-0 flex-col gap-1 border-b border-line px-4 py-3 text-left",
          "transition-colors hover:bg-surface-hover",
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            className="min-w-0 flex-1 truncate text-body text-ink"
            data-testid="ade-card-title"
          >
            {item.title}
          </span>
          <span
            className={cn(CHIP_CLASS, STATE_CHIP_CLASS[item.state])}
            data-testid="ade-card-state"
          >
            {ADE_STATE_LABEL[item.state]}
          </span>
          {/* 경과. 끝난 세션은 자기 종료 시각에서 멈춘다. 시작을 못 본 턴은
              숫자를 지어내지 않고 자리만 비운다 (workingSignal 의 같은 규칙). */}
          <span
            data-numeric
            data-testid="ade-card-elapsed"
            className="shrink-0 font-mono text-timestamp text-ink-muted"
          >
            {item.startedAtMs === undefined
              ? "\u200b"
              : elapsedLabel(item.startedAtMs, item.endedAtMs ?? nowMs)}
          </span>
        </span>
        <span className="flex min-w-0 items-baseline gap-1 text-meta text-ink-muted">
          {/* 생존성이 첫 조각인 이유: 이 줄에서 사람이 「랩탑을 덮어도 되나」를
              결정하는 사실이 이것 하나다. 턴 카드에는 아예 없다 — 호스트가 없는
              것과 호스트를 모르는 것은 다른 사실이고, 앞의 것을 경고로 그리면
              모든 턴이 경고를 하나씩 달고 선다(코어 `itemDurabilityBadge`). */}
          {durability !== null && (
            <>
              <span
                className={cn(
                  "shrink-0",
                  DURABILITY_TONE_CLASS[durabilityTone(item.durability)]
                )}
                data-testid="ade-card-durability"
              >
                {durability}
              </span>
              <span className="shrink-0">·</span>
            </>
          )}
          <span className="min-w-0 truncate" data-testid="ade-card-channel">
            {channelName}
          </span>
          <span className="shrink-0">·</span>
          {/* 3분류 칩보다 정밀한 원래 사실. 칩은 요약 줄이 센 것과 같은 어휘여야
              하고, 원장이 아는 더 정확한 말은 그 대가로 사라지면 안 된다. */}
          <span className="min-w-0 truncate" data-testid="ade-card-detail">
            {item.detail}
          </span>
        </span>
        {/* 리뷰 병목 방어의 첫 칸(D2). 값이 오기 전에는 **자리만** 잡는다 —
            나중에 `+42 -18` 이 붙어도 카드 높이가 바뀌지 않게. `+0 -0` 을 그리지
            않는 이유는 코어 `adeDiffLabel` 에 있다: 「모른다」는 「안 바꿨다」가
            아니다. 빈 문자열이 아니라 zero-width space 인 것은 빈 span 이
            line-height 를 갖지 않아 자리를 예약하지 못하기 때문이다. */}
        <span
          data-numeric
          data-testid="ade-card-diff"
          data-empty={diff === null ? "" : undefined}
          aria-hidden={diff === null ? "true" : undefined}
          className="font-mono text-timestamp text-ink-muted"
        >
          {diff ?? "\u200b"}
        </span>
      </button>
    </li>
  );
}

export function AdeDrawer() {
  const { workspaceId, session } = useSession();
  const { items, nowMs, sessionsFailed, retrySessions } = useAdeControl(true);
  const navigate = useNavigate();
  const channelsQuery = useChannels(workspaceId);
  const { directory } = useDirectory(workspaceId);
  const asideRef = useRef<HTMLElement>(null);
  const openerRef = useRef<ReturnType<typeof takeAdeDrawerOpener>>(null);

  const channels = channelsQuery.groups;
  const nameOfChannel = useMemo(() => {
    const all = [...channels.channels, ...channels.dms];
    return (channelId: string) => {
      const channel = all.find((candidate) => uuidEq(candidate.id, channelId));
      // 명부가 아직이거나 내가 못 보는 방이면 방 이름을 지어내지 않는다.
      return channel === undefined
        ? "다른 채널"
        : channelLabel(channel, directory, session.member.id);
    };
  }, [channels, directory, session.member.id]);

  // 캐럿을 서랍 안으로 들인다. 덮인 라우트가 `inert` 라 밖에 두면 탭이 갈 곳이
  // 없다(design/ui/dialog.tsx 의 집 규칙과 같은 이유).
  useEffect(() => {
    openerRef.current = takeAdeDrawerOpener();
    asideRef.current?.focus();
  }, []);

  const close = useCallback(() => {
    const opener = openerRef.current;
    closeAdeDrawer();
    restoreDialogOpenerFocus(opener);
  }, []);

  // Esc 는 서랍 밖에서 눌러도 듣는다. 라우트를 덮고 있는 층이 이 서랍이므로 Esc 는
  // 이 층의 것이고, 캡처 단계에서 가져가는 이유는 사이드바 서랍이 같은 자리에서
  // 적어 둔 그대로다: 설정 라우트가 window 에서 Esc 를 듣고 뒤로 가는데, 그 쪽이
  // 먼저 돌면 서랍을 닫으려던 한 번이 라우트 이동까지 해버린다. 다이얼로그가 열려
  // 있으면 비켜준다 — 그때 가장 위 층은 그 다이얼로그다.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      event.stopPropagation();
      event.preventDefault();
      close();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [close]);

  const openItem = useCallback(
    (item: AdeItem) => {
      // 카드가 확대되면 서랍은 물러난다. 둘이 같은 층에 겹쳐 서면 위에 있는 쪽이
      // 아래를 가린 채로 남고, 사람은 방금 누른 카드가 어디 갔는지 모른다.
      close();
      if (item.kind === "run" && item.runId && item.memberId) {
        openWorkPanel(
          {
            runId: item.runId,
            memberId: item.memberId,
            channelId: item.channelId,
            origin: "ade",
            ...(item.startedAtMs !== undefined
              ? { startedAtMs: item.startedAtMs }
              : {}),
          },
          openerRef.current instanceof HTMLElement ? openerRef.current : null
        );
        return;
      }
      if (item.sessionId) {
        // `?work=` 는 작업 세션 패널이 이미 읽는 열쇠다(ChatShell). 작업 세션은
        // 라우트가 아니라 채널 표면 안의 패널이라, 링크가 채널과 세션을 함께
        // 말한다 — 여기서 그 계약을 소비만 한다.
        navigate(
          `/channels/${encodeURIComponent(item.channelId)}?work=${encodeURIComponent(
            item.sessionId
          )}`
        );
      }
    },
    [close, navigate]
  );

  return (
    <aside
      ref={asideRef}
      id={ADE_DRAWER_DOM_ID}
      tabIndex={-1}
      aria-label="작업 목록"
      data-testid="ade-drawer"
      className="ade-drawer flex flex-col border-e border-line bg-surface"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-2">
        <h2 className="min-w-0 flex-1 truncate text-body font-semibold">
          작업 목록
        </h2>
        <button
          type="button"
          onClick={close}
          aria-label="작업 목록 닫기"
          data-testid="ade-drawer-close"
          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <X className="size-4" />
        </button>
      </header>
      {sessionsFailed && (
        <InlineBanner
          message="작업 세션 목록을 불러오지 못했습니다. 아래 목록에는 에이전트 턴만 있습니다."
          actionLabel="다시 시도"
          onAction={retrySessions}
          testId="ade-sessions-error"
        />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <EmptyInvite
            headline={ADE_DRAWER_EMPTY_HEADLINE}
            detail={ADE_DRAWER_EMPTY_DETAIL}
            testId="ade-drawer-empty"
          />
        ) : (
          <ul data-testid="ade-card-list">
            {items.map((item) => (
              <AdeCard
                key={item.key}
                item={item}
                channelName={nameOfChannel(item.channelId)}
                nowMs={nowMs}
                onOpen={() => openItem(item)}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
