import { useCallback, useRef } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  adeSummaryLabel,
  adeSummarySegments,
} from "@momo/core/features/work/adeControl";
import { cn } from "@/design/lib/cn";
import { useAdeControl } from "./useAdeControl";
import {
  ADE_DRAWER_DOM_ID,
  closeAdeDrawer,
  openAdeDrawer,
  useAdeDrawerOpen,
} from "./adeDrawerStore";

// =============================================================================
// 대화 공간의 **한 줄** (ADR-0154 D2 — 성재 수정: "대화 공간에는 '실행 중인 작업
// 1개…' 같은 summary로 보이고 클릭하면 drawer 형태").
//
// 3층의 첫 층이다. 이 줄이 나르는 정보는 **개수와 상태 두 가지**이고, 그 이상은
// 아래층의 몫이다: 무엇이 도는지는 서랍이, 어떻게 도는지는 터미널이 말한다.
//
// ## 왜 셸에 있고 채널에 없는가
//
// 재료의 절반(작업 세션 원장)이 워크스페이스 전역이고, 나머지 절반(열린 턴)도
// 채널마다 흩어져 있다. 채널 헤더에 두면 지금 보고 있는 방 밖에서 도는 작업은
// 화면에서 사라지는데, 관제 표면이 「내가 안 보고 있는 것」을 못 보여주면 그것은
// 관제가 아니다. 같은 판정을 이 셸이 이미 한 번 했다 — 연결 배너가 채널에서 셸로
// 올라간 이유가 "인박스도 활동도 갱신이 멈추는데 채널에서만 말하면 모른다"였다.
//
// 그래서 각 카드는 자기 채널 이름을 달고 다닌다(서랍). 채널이 세션의 홈이라는
// 원칙은 그대로다.
//
// ## 자리를 예약하지 않는다 (설계 판단, 근거는 코어 `adeSummarySegments` 주석)
//
// 작업이 하나도 없으면 이 컴포넌트는 `null` 이다 — 빈 띠도 남기지 않는다. 「작성
// 중」 줄이 자리를 예약하는 것과 반대 판정이고, 그 셋의 근거가 코어 주석에 있다:
// 미는 대상이 다르고(캐럿이 아니라 타임라인의 가용 높이), 빈도와 원인이 다르며
// (남의 키가 아니라 대개 자기 행동), 예약된 빈 띠는 그 자체로 한 줄이라서다.
//
// **밀림 방어는 서랍 쪽에 있다**: 서랍은 절대 위치로 라우트를 덮고, 게이트가 여는
// 전후의 좌표를 픽셀로 잰다.
//
// ## live 영역이 아니다
//
// `aria-live` 를 걸지 않는다. 이 줄은 「작성 중」 줄이나 작업 패널의 1Hz 시계와
// 같은 부류다: 갱신이 잦고, 낭독이 사람의 작업을 끊는다. 숫자는 DOM 에 있으므로
// 읽으려는 사람은 언제든 읽을 수 있고, 강제로 끼어들지 않는다. 사람이 반드시
// 알아야 하는 전이(승인 요청·멘션)는 이 줄이 아니라 인박스와 OS 알림의 몫이다.
// =============================================================================

/** 조각 종류 -> 표지. 숫자만 `data-numeric` 이고, 대기는 accent 를 입는다. */
const SEGMENT_CLASS = {
  plain: "text-ink-muted",
  count: "text-ink",
  blocked: "text-accent",
  blockedCount: "text-accent",
} as const;

export function AdeSummaryLine() {
  const open = useAdeDrawerOpen();
  const { counts } = useAdeControl(open);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const segments = adeSummarySegments(counts);
  const label = adeSummaryLabel(counts);

  const toggle = useCallback(() => {
    if (open) closeAdeDrawer();
    else openAdeDrawer(buttonRef.current);
  }, [open]);

  // 살아 있는 작업이 없으면 줄 자체가 없다. 서랍이 열린 채로 마지막 작업이 끝나면
  // 이 줄은 사라지고 서랍은 남는다(서랍이 자기 빈 상태를 말한다) — 사람이 보고
  // 있는 것을 손 밑에서 걷어내지 않는다.
  if (segments.length === 0 || label === null) return null;

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={toggle}
      aria-expanded={open}
      aria-controls={ADE_DRAWER_DOM_ID}
      data-testid="ade-summary"
      data-working={counts.working}
      data-blocked={counts.blocked}
        className={cn(
        "tap-target flex w-full shrink-0 items-center justify-between gap-2",
        "border-b border-line px-4 py-2 text-left text-meta",
        "focus-visible:focus-ring",
        open
          ? "bg-surface-hover active:bg-surface-pressed"
          : "hover:bg-surface-hover active:bg-surface-pressed"
      )}
    >
      {/* 보조기술이 읽는 것은 이것 하나다. 아래 보이는 조각들은 폭에 따라 잘릴 수
          있고, 잘린 텍스트를 읽어 주는 것은 이 줄이 하려는 말이 아니다
          (`TypingLine` 이 같은 결함을 같은 방법으로 고쳤다). */}
      <span className="sr-only" data-testid="ade-summary-label">
        {label}
      </span>
      <span
        aria-hidden="true"
        className="min-w-0 truncate"
        data-testid="ade-summary-text"
      >
        {segments.map((segment, index) => (
          <span
            key={index}
            className={SEGMENT_CLASS[segment.kind]}
            data-ade-segment={segment.kind}
            {...(segment.kind === "count" || segment.kind === "blockedCount"
              ? { "data-numeric": "" }
              : {})}
          >
            {segment.text}
          </span>
        ))}
      </span>
      {/* 누를 수 있다는 것을 말하는 유일한 표지. 상태 점이 아니라 방향이라서
          장식이 아니다(design-taste-web §8: 의미 없는 점 금지). */}
      <span aria-hidden="true" className="shrink-0 text-ink-muted">
        {open ? (
          <ChevronUp className="size-4" />
        ) : (
          <ChevronDown className="size-4" />
        )}
      </span>
    </button>
  );
}
