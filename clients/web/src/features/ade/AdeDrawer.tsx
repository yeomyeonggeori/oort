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
import { HANDOFF_COPY } from "@momo/core/features/work/sessionHandoff";
import { elapsedLabel } from "@momo/core/features/agents/workingSignal";
import { cn } from "@/design/lib/cn";
import { useSession } from "@/app/session";
import { ROUTE_REGION_DOM_ID } from "@/app/shellNav";
import { CHIP_CLASS } from "@/features/common/chip";
import { EmptyInvite, InlineBanner } from "@/features/common/States";
import { openWorkPanel } from "@/features/agents/workLogStore";
import { messageAnchorPath, workSessionPath } from "@/features/inbox/anchor";
import {
  channelLabel,
  useChannels,
  useDirectory,
} from "@/features/workspace/useWorkspace";
import { restoreDialogOpenerFocus } from "@/design/ui/dialog";
import { useEscapeLayer } from "@/design/ui/escapeLayer";
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
// ## 카드에는 도착지가 둘이다 (#1193)
//
// 확대(카드 본체)는 「지금 무엇을 하고 있나」로 가고, 「대화로」는 「왜 시작
// 됐나」로 간다. 둘을 한 컨트롤에 접을 수 없는 이유는 그 둘이 다른 질문이기
// 때문이다 — 관전하러 온 사람과 맥락을 찾으러 온 사람은 같은 카드를 다른 이유로
// 누른다. 서버는 그 두 번째 사실을 처음부터 들고 있었다(`work_session.
// root_message_id`, 019 마이그레이션); 이 배치는 그것을 화면까지 연결한다.
//
// ## 레이아웃을 밀지 않는다
//
// 기하는 tokens.css `ade-drawer` 한 곳에 있다: 절대 위치로 라우트 상자를 덮고,
// 흐름에서 폭도 높이도 가져가지 않는다. 「작성 중」 줄이 컴포저를 26px 밀었던
// 결함(리뷰 H-2)과 같은 종류를 이 층에서 미리 닫는 것이고, 게이트가 여는 전후의
// 좌표를 픽셀로 재서 그것이 실제로 성립하는지 본다.
//
// 덮인 라우트는 `inert` 로 탭 순서에서 함께 빠진다(AppShell). 형제 표면인 작업
// 패널도 같은 규칙을 받는다(`AgentWorkPanel`) — 서랍이 열려 있는 동안 살아 있는
// 것은 서랍과 스크림, 그리고 서랍 밖에 있는 셸(사이드바·요약 줄)뿐이다.
//
// ## 스크림 (design-review ADE 2단계 H2)
//
// 1차에는 스크림을 두지 않았다. 근거는 "라우트의 왼쪽만 덮으므로 오른쪽을 어둡게
// 칠하면 못 쓰는 이유를 설명하지 못한다"였는데, 리뷰가 잰 결과는 그 반대였다:
// 오른쪽 절반은 `inert` 라 아무 버튼도 눌리지 않으면서 **살아 있는 것과 똑같이
// 보였다**(허들 버튼을 눌러도 아무 일도 일어나지 않는다). 「보이면 반응한다」를
// 지키는 길은 둘뿐이고 — 반응하게 하거나, 반응하지 않는다고 말하거나 — 덮고 있는
// 층이 있는 한 앞의 것은 택할 수 없다.
//
// 그래서 같은 셸이 이미 세워 둔 선례를 그대로 쓴다: 사이드바 서랍의 `sidebar-scrim`
// 은 `--scrim` 으로 뒤를 눌러 놓고 **진짜 <button>** 으로 서서 바깥을 눌러 닫는
// 길을 마우스 전용이 아니게 만든다. 그쪽 기하도 여기와 같다(280px 서랍 + 남은
// 110px). 한 셸에 서랍이 둘인데 규칙이 둘이면, 사람은 어느 쪽에서 배운 것을
// 다른 쪽에서 쓸 수 없다.
// =============================================================================

// 그릇은 세 칸이 전부 --muted-soft 다 (#1515 회전 1). 앞 판의 --surface-hover ·
// --accent-soft 는 둘 다 **행이 입는 상태의 이름**이고, 이 카드의 행(아래 :158)이
// 바로 `hover:bg-surface-hover` 로 선다 — 가리키는 순간 칩이 행에 녹았다(실측 대비
// 1.000). 잉크는 그대로다: 갈라진 것은 그릇이고, 색을 버는 것은 측정이지 이름이
// 아니므로 톤은 잉크에만 남는다.
const STATE_CHIP_CLASS: Readonly<Record<AdeState, string>> = {
  // 실행 중은 「지금 흐르고 있다」 — 작업 세션 패널의 running 과 같은 표지다.
  working: "bg-muted-soft text-warn",
  // 대기만 accent 를 입는다. 이 화면에서 사람을 부르는 유일한 상태이고, 같은
  // 규칙을 작업 세션 패널이 「호스트 연결 끊김」에 이미 쓴다.
  blocked: "bg-muted-soft text-accent",
  idle: "bg-muted-soft text-ink-muted",
};

const DURABILITY_TONE_CLASS = {
  ok: "text-ok",
  muted: "text-ink-muted",
  warn: "text-warn",
} as const;

/**
 * 「대화로」의 글자와 그 칸 (#1193 · 리뷰 H1·H2).
 *
 * 라벨과 기하가 **한 곳**에 있는 이유: 이 칸은 동사가 있는 행과 없는 행에서 폭이
 * 글자 하나까지 같아야 하고(H1 의 수리가 그것이다), 두 자리에 나눠 적으면 다음에
 * 라벨을 고치는 사람이 유령만 옛 폭으로 남긴다.
 */
const ANCHOR_LABEL = "대화로";
const ANCHOR_CELL_CLASS =
  "flex shrink-0 items-center border-s px-3 text-body font-medium";

function AdeCard({
  item,
  channelName,
  nowMs,
  onOpen,
  onOpenAnchor,
}: {
  item: AdeItem;
  channelName: string;
  nowMs: number;
  onOpen: () => void;
  onOpenAnchor: () => void;
}) {
  const durability = itemDurabilityBadge(item);
  const diff = adeDiffLabel(item.diff);
  // 이 카드에서 성립하는 동사 (ADR-0154 D3). 카드는 동사를 **말하되 실행하지
  // 않는다**: 누르면 그 동사가 사는 표면이 열린다.
  //
  // 인수를 이 320px 서랍 안에서 끝내지 않은 것은 판단이다. 인수는 호스트 선택 +
  // 부분 복원 고지 + 사전조건 문장을 함께 세워야 하고(코어 `TAKEOVER_*`), 그
  // 셋을 카드 안에 접어 넣으면 서랍은 관제가 아니라 폼 목록이 된다. 게다가 이
  // 카드는 이미 <button> 하나라, 그 안에 두 번째 버튼을 두는 것은 마크업이
  // 허락하지 않는다. 그래서 카드는 **무엇을 할 수 있는지**까지 말하고, 그 일이
  // 실제로 일어나는 곳으로 데려간다.
  const handoff = item.handoff === undefined ? null : HANDOFF_COPY[item.handoff];
  return (
    // 행이 둘로 갈린다 (#1193). 「대화로」는 카드 안이 아니라 **옆**에 서는데,
    // 카드가 이미 <button> 하나라 그 안에 두 번째 버튼을 둘 수 없기 때문이다
    // (아래 `handoff` 주석이 D3 때 같은 벽을 만나 힌트만 적어 둔 그 자리다).
    // 형제로 세우는 대신 테두리가 이 <li> 로 올라온다 — 두 컨트롤은 한 행이고,
    // 행의 아래선이 어느 한쪽의 것이면 다른 쪽 밑에서 선이 끊긴다.
    <li className="flex items-stretch border-b border-line">
      <button
        type="button"
        onClick={onOpen}
        data-testid="ade-card"
        data-kind={item.kind}
        data-state={item.state}
        data-durability={item.durability}
        data-handoff={item.handoff ?? undefined}
        data-anchor={item.anchorMessageId === undefined ? undefined : ""}
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-1 px-4 py-3 text-left",
          "transition-colors hover:bg-surface-hover",
          "focus-visible:focus-ring"
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
          {/* \uc790\ub9ac\ud45c\ub294 \ubcf4\uc870\uae30\uc220\uc774 \uc77d\uc744 \uac83\uc774 \uc544\ub2c8\ub2e4(design-review N2): \uc2dc\uc791\uc744 \ubabb \ubcf8
              \ud134\uc758 \uc774 \uce78\uc740 zero-width space \ud55c \uae00\uc790\uc774\uace0, \uadf8\uac83\uc774 \uce74\ub4dc\uc758 \uc811\uadfc \uc774\ub984\uc5d0
              \uc11e\uc774\uba74 \ub0ad\ub3c5\uc740 \uc81c\ubaa9\uacfc \ucc44\ub110 \uc0ac\uc774\uc5d0\uc11c \uc774\uc720 \uc5c6\uc774 \ud55c \ubc88 \uba4e\ub294\ub2e4. diff \uce78\uc774
              \uac19\uc740 \uc790\ub9ac\uc5d0\uc11c \uc774\ubbf8 \ud558\uace0 \uc788\ub294 \ucc98\ub9ac\ub97c \uc5ec\uae30\uc11c\ub3c4 \ud55c\ub2e4. */}
          <span
            data-numeric
            data-testid="ade-card-elapsed"
            data-empty={item.startedAtMs === undefined ? "" : undefined}
            aria-hidden={item.startedAtMs === undefined ? "true" : undefined}
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
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            data-numeric
            data-testid="ade-card-diff"
            data-empty={diff === null ? "" : undefined}
            aria-hidden={diff === null ? "true" : undefined}
            className="min-w-0 flex-1 font-mono text-timestamp text-ink-muted"
          >
            {diff ?? "\u200b"}
          </span>
          {/* \uc774 \uce74\ub4dc\ub97c \ub204\ub974\uba74 \ubb34\uc5c7\uc744 \ud560 \uc218 \uc788\ub294\uac00 (ADR-0154 D3). \ub450 \ub3d9\uc0ac\ub294 \uc11c\ub85c
              \ub2e4\ub978 \ub0b1\ub9d0\uc774\uace0 \ub2e4\ub978 \uc789\ud06c\ub97c \uc9c4\ub2e4: \uc778\uc218\ub294 \uc0ac\ub78c\uc774 \uc6c0\uc9c1\uc5ec\uc57c \ub05d\ub098\ub294
              \uc77c\uc774\ub77c accent \ub97c \uc785\uace0(\uc774 \ud654\uba74\uc5d0\uc11c \uc0ac\ub78c\uc744 \ubd80\ub974\ub294 \ucd95\uc774 \uadf8\uac83\uc774\ub2e4),
              \uc7ac\uac1c\ub294 \uadf8\ub0e5 \ub3cc\uc544\uac00\ub294 \uac83\uc774\ub77c \ubb3c\ub7ec\uc120\ub2e4.

              \ub3d9\uc0ac\uac00 \uc5c6\ub294 \uce74\ub4dc\uc5d0\ub294 **\uc544\ubb34 \ub9d0\ub3c4 \ud558\uc9c0 \uc54a\ub294\ub2e4**. \u300c\ud560 \uc218 \uc788\ub294 \uac83\uc774
              \uc5c6\uc74c\u300d\uc744 \uce78\ub9c8\ub2e4 \uadf8\ub9ac\uba74 \uadf8 \ubb38\uad6c\uac00 \ubaa9\ub85d\uc758 \uae30\ubcf8\uac12\uc774 \ub418\uace0, \uadf8\ub54c \uadf8\uac83\uc740
              \uc815\ubcf4\uac00 \uc544\ub2c8\ub77c \ubc30\uacbd\uc774\ub2e4 \u2014 `itemDurabilityBadge` \uac00 \ud134 \uce74\ub4dc\uc5d0 \ub300\ud574
              \uc138\uc6b4 \uac83\uacfc \uac19\uc740 \uaddc\uce59. */}
          {handoff !== null && (
            <span
              data-testid="ade-card-handoff"
              className={cn(
                "shrink-0 text-timestamp",
                item.handoff === "takeover" ? "text-accent" : "text-ink-muted"
              )}
            >
              {handoff.button}
            </span>
          )}
        </span>
      </button>
      {/* 「대화로」 — 이 작업을 낳은 메시지로 (#1193).
       *
       * 카드 본체와 **다른 곳**으로 간다. 본체는 그 작업이 지금 무엇을 하고
       * 있는지(작업 세션 패널 · 작업 패널)로 확대되고, 이 동사는 그 작업이
       * 왜 시작됐는지가 적힌 줄로 간다. 서랍이 워크스페이스 전역이라 그 줄은
       * 대개 지금 보고 있는 방에 없다.
       *
       * ## 칸은 **모든 행에 있다** (리뷰 H1)
       *
       * 1차 판은 앵커가 있을 때만 칸을 세웠고, 그래서 사람이 이 표면에서 가장
       * 먼저 훑는 열(상태 칩 + 경과)이 카드 종류에 따라 두 오른쪽 끝을 갖게
       * 됐다. 실측: 세션 행 x=806 · 턴 행 x=861 이 여섯 줄에서 번갈아 섰다.
       * 목록에서 눈이 따라가는 것은 그 모서리이지 각 행의 내용이 아니다.
       *
       * 그래서 동사가 없는 행은 **같은 폭의 유령**을 세운다. 지워진 글자로 폭을
       * 잡는 것은 이 카드가 diff 칸에서 이미 하는 일이고(zero-width space), 임의
       * 픽셀값을 새로 짓지 않는 유일한 방법이기도 하다 — 칸의 폭은 라벨이 정한다.
       *
       * **버튼은 그리지 않는다.** 유령은 `visibility: hidden` 이라 탭 순서에도
       * 낭독에도 클릭에도 없다(리뷰가 잰 「턴 카드에 두 번째 정거장 없음」은 그대로
       * 참이다). 죽은 버튼 금지는 자리가 아니라 **컨트롤**에 대한 규율이다.
       *
       * ## 컨트롤처럼 읽히게 (리뷰 H2)
       *
       * `text-meta text-ink-muted` 는 이 카드의 **메타데이터** 역할이라, 바로 옆
       * 「이어서 보기」(누를 수 없는 힌트)와 같은 잉크·거의 같은 크기로 섰다.
       * 정지 화면에서 어느 쪽이 눌리는지 말하는 것이 하나도 없었다.
       *
       * 색으로 갚지 않는다: 여섯 장짜리 목록에서 accent 낱말 넷은 accent 가 아니게
       * 된다. 대신 비색 축 셋이다 — `text-body`(토큰 정의가 "message body and
       * **controls**" 라고 적어 둔 그 단), `font-medium`, 그리고 컨트롤 테두리로
       * 3:1 을 만족하는 `--line-strong`. 유령도 폭이 같아야 하므로 같은 타이포를
       * 든다.
       *
       * 접근 이름이 보이는 글자를 **품는다**(WCAG 2.5.3). 그리고 그 안에서
       * 목적지를 정확히 말한다: 이 카드에서 본체도 「대화」로 가므로(폰에서는 같은
       * 방이다) 낱말만으로는 둘이 구별되지 않는다. */}
      {item.anchorMessageId === undefined ? (
        <span
          aria-hidden="true"
          data-testid="ade-card-anchor-ghost"
          className={cn(ANCHOR_CELL_CLASS, "invisible border-line")}
        >
          {ANCHOR_LABEL}
        </span>
      ) : (
        <button
          type="button"
          onClick={onOpenAnchor}
          aria-label={`${item.title}, 이 작업을 시작한 메시지가 있는 ${ANCHOR_LABEL} 이동`}
          data-testid="ade-card-anchor"
          className={cn(
            ANCHOR_CELL_CLASS,
            "border-line-strong text-ink-muted",
            "transition-colors hover:bg-surface-hover hover:text-ink",
            "focus-visible:focus-ring"
          )}
        >
          {ANCHOR_LABEL}
        </button>
      )}
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
    if (restoreDialogOpenerFocus(opener)) return;
    // opener 가 사라진 판이 실제로 있다 (design-review N1): 서랍을 열어 둔 채
    // 마지막 작업이 끝나면 요약 줄은 DOM 에서 빠지고(빈 자리를 예약하지 않는 것이
    // 그 줄의 계약이다) 서랍만 남는다. 그 상태로 닫으면 캐럿이 <body> 로 떨어져
    // 키보드 사용자는 셸 맨 위부터 다시 Tab 해야 한다.
    //
    // 폴백은 방금 돌려받은 표면 그 자체다. `inert` 를 손으로 먼저 걷는 이유는
    // 사이드바 서랍의 `closeDrawer` 가 적어 둔 그대로다: React 는 이 커밋이
    // 끝나야 속성을 걷으므로 그 전에 `focus()` 를 부르면 inert 가 거절한다.
    const route = document.getElementById(ROUTE_REGION_DOM_ID);
    route?.removeAttribute("inert");
    route?.focus();
  }, []);

  // Esc 는 서랍 밖에서 눌러도 듣는다. 라우트를 덮고 있는 층이 이 서랍이므로 Esc 는
  // 이 층의 것이다 — 그리고 그 문장이 참이 되는 자리는 이제 이 파일이 아니라
  // `escapeLayer` 스택이다(리뷰 H1 ①: 같은 타깃 같은 단계의 리스너 둘은 서로를
  // 막지 못해서, 작업 패널과 이 서랍이 Esc 한 번에 함께 닫혔다).
  useEscapeLayer(true, close);

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
        //
        // **주소를 손으로 짓지 않는다** (design-review B1). 1차에는 여기서
        // `/channels/{id}?work=` 를 지었는데 라우트 표에 있는 것은 `c/:channelId`
        // 뿐이라 와일드카드가 받아 `/` 로 돌려보냈다: 세션 카드는 첫 클릭에서
        // 채널도 세션도 잃고 홈에 도착했다. 그 주소를 만드는 자리는 이미
        // 있었고(`inbox/anchor.ts` 의 `workSessionPath`, MOMO-679 에서 작업 흐름
        // 상세가 쓰는 그것), 링크를 두 곳에서 지으면 한 곳만 낡는다.
        navigate(workSessionPath(item.channelId, item.sessionId));
      }
    },
    [close, navigate]
  );

  /**
   * 발원 대화로 (#1193).
   *
   * `?msg=` 는 **id 하나로 착지하는 기존 문법**이고(`inbox/anchor.
   * messageAnchorPath`, MOMO-677), 그 문법이 있는 이유가 정확히 이 경우다 —
   * 그쪽 주석: "The goal layer knows its anchor thread by `rootMessageId` and
   * never sees a seq." 세션 원장도 seq 를 나르지 않으므로 같은 열쇠를 쓴다.
   *
   * 여기서 워처를 부르지 않는다. `ChatShell` 이 `?msg=` 를 읽고 스스로
   * `watchForMessageId` 를 걸며, 못 찾았을 때의 문장(`chat-anchor-missed`)도
   * 그쪽이 든다. 이 서랍이 한 번 더 걸면 같은 행에 두 워처가 붙고, 둘의 만료
   * 타이머는 서로를 모른다.
   */
  const openAnchor = useCallback(
    (item: AdeItem) => {
      if (item.anchorMessageId === undefined) return;
      close();
      navigate(messageAnchorPath(item.channelId, item.anchorMessageId));
    },
    [close, navigate]
  );

  return (
    <>
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
          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover focus-visible:focus-ring"
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
                onOpenAnchor={() => openAnchor(item)}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
    {/* 스크림은 서랍 **다음**에 있다: 서랍이 열린 동안 탭이 갈 수 있는 곳은 서랍과
     * 이 버튼뿐이라(라우트와 작업 패널은 inert) DOM 순서가 곧 그 순환이고,
     * 사이드바 서랍이 같은 자리에서 같은 순서를 고른 이유도 그것이다. 아이콘도
     * 글자도 없는 표면이 진짜 <button> 인 이유 역시 같다 — 바깥을 눌러 닫는 것이
     * 마우스로만 되는 행동이면 안 된다. */}
    <button
      type="button"
      onClick={close}
      aria-label="작업 목록 닫기"
      data-testid="ade-scrim"
      className="ade-scrim"
    />
    </>
  );
}
