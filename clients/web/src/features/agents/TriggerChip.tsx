import { Ban, Check, CircleAlert, CircleDot, CircleX, Clock, Eye, Hand, ShieldQuestion, type LucideIcon } from "lucide-react";
import type { AgentRunProgress } from "@momo/core/lib/api";
import { nextUncollectedDeadlineMs } from "@momo/core/features/agents/runException";
import { UNKNOWN_AGENT_NAME } from "@momo/core/features/agents/turnCopy";
import {
  TRIGGER_CHIP_FACES,
  triggerChip,
  type AnswerRef,
  type TriggerChip,
  type TriggerChipKind,
  type TriggerChipMark,
} from "@momo/core/features/agents/triggerChip";
import { cn } from "@/design/lib/cn";
import { CHIP_CLASS } from "@/features/common/chip";
import { TRIGGER_CHIP_CLASS, TRIGGER_CHIP_TONE_CLASS } from "./triggerChipClasses";
import { memberNameParts, type Directory } from "@/features/workspace/useWorkspace";
import { useRerenderAt } from "./useRerenderAt";
import { runBundleSnapshot } from "@momo/core/features/timeline/requestBundle";

// =============================================================================
// 에이전트를 부른 메시지의 상태 칩 (#4619, #4577 권장 B).
//
//   이도현 오후 3:07  [받음]  →  [가져감]  →  [● 작업 중]  →  [✓ 답함]   [! 아직 받지 않았어요]  [◷ 시간 초과]  [✕ 실패]
//
// 에이전트를 부른 사람의 메시지 머리 줄(시각 옆)에 **크기가 고정된** 칩 하나가 선다. 예전의 문장 행
// (「받았어요 → 깨우는 신호 보냄 → 가져감 → …」)을 대신한다. 누가 불렀든 선다(planner 결정 2). 한 낱말이라
// 상태가 바뀌어도 줄의 높이도 칩의 폭도 변하지 않는다.
//
// ## 크기 고정은 어떻게
//
// 칩 폭을 숫자로 못 박지 않고 **가장 넓은 낱말에 맞춘다**: 가능한 모든 (낱말, 표지) 조합을 같은
// 격자 칸에 겹쳐 두고 지금 것만 보이게 한다(나머지는 `invisible`, `aria-hidden`). 칩의 폭은 어느
// 낱말이 서 있든 가장 넓은 조합의 폭이고, 낱말이 번역으로 길어져도 따라간다(7개 언어, ADR-0213).
// 높이는 칩 기하(`CHIP_CLASS`)가 정한다. 시험이 실제 엔진에서 낱말을 갈아 끼우며 폭·높이를 잰다.
//
// ## 두 모양: 낱말 칩과 아이콘 칩
//
// 낱말 칩이 기본이다. 자리가 모자라면 같은 칩이 **아이콘만** 남긴다(낱말은 보조기술 이름·툴팁으로 남는다):
//   - 머리 줄이 좁을 때(`@max-sm`, 줄 자신의 폭 < 24rem): 이름이 칩 때문에 잘리지 않게. 머리 줄은 줄바꿈이
//     없으므로(`MESSAGE_HEAD_CHIP_CLASS`) 칩이 클수록 이름이 줄어든다.
//   - 머리 줄이 없는 **이어지는 행**(같은 사람의 연속 메시지)의 거터: 시각이 서는 그 자리에 선다(`GutterTriggerChip`).
//     거터(32px + 행 여백 16px)에 낱말은 들어가지 않는다.
// 아이콘 칩은 글자 없이 모양만으로 여덟 상태가 갈려야 해서 낱말 칩에 없던 표지도 하나씩 갖는다
// (`MarkGlyph`). 그릇 높이는 낱말 칩과 같다: 폭 0으로 접은 낱말이 줄 상자의 높이를 지킨다.
//
// ## 낱말과 모양
//
// 낱말과 상태 판정은 코어 `triggerChip`이 정한다(레일과 같은 낱말). 모양은 색에만 기대지 않는다:
// 점(작업 중)·체크(답함)·느낌표(아직 받지 않았어요)·시계(시간 초과·신호 소실)·가위표(실패, 위험 톤). 느낌표와 시계는 경고
// 톤이다. 서버가 일을 끝내지
// 못한 것은 오류가 아니라서(ADR-0132) 위험 톤·가위표는 서버가 `failed`로 끝낸 것에만 쓴다. 그릇은 칩 그릇 규칙
// (`chipVessel.test`)의 넷(`muted/ok/warn/danger-soft`)만 쓴다.
//
// 「답함 ✓」은 답 메시지를 알 때만 눌리는 단추다(눌러도 갈 곳이 없는 단추를 세우지 않는다). 거터의 칩은
// 눌리지 않는다: 행에 포인터가 오면 그 자리가 시각으로 바뀌므로(아래) 누를 수 있는 단추를 거기 둘 수 없다.
// =============================================================================

function Face({ word, mark }: { word: string; mark: TriggerChipMark }) {
  return (
    <span className="inline-flex items-center justify-center gap-1 whitespace-nowrap">
      {mark === "dot" && <span aria-hidden="true" className="size-1 rounded-full bg-warn" />}
      {mark === "check" && <Check aria-hidden="true" className="size-3" />}
      {mark === "alert" && <CircleAlert aria-hidden="true" className="size-3" />}
      {mark === "clock" && <Clock aria-hidden="true" className="size-3" />}
      {mark === "cross" && <CircleX aria-hidden="true" className="size-3" />}
      {mark === "ban" && <Ban aria-hidden="true" className="size-3" />}
      {word}
    </span>
  );
}

/**
 * 아이콘 칩의 글리프: 상태가 **모양으로** 갈린다. 낱말 칩에서 표지가 없던 셋(받음·가져감·승인 대기)도 여기서는
 * 하나씩 갖는다 — 글자 없는 빈 칩은 상태를 말하지 못하므로. 받음은 눈(요청이 닿아 눈에 띔, Buzz의 👀와 같은 뜻),
 * 가져감은 손, 승인 대기는 사람에게 묻는 방패(작업 카드가 쓰는 그것), 작업 중은 속이 찬 원(원 안의 점).
 * 모두 lucide다(§2.8: 손으로 그린 `<svg>`는 예외 목록 밖이면 `iconSystem.test`가 붉다). 상태 원 셋(작업 중·주의·오류)은
 * 같은 원 계열이라 한 가족으로 읽힌다.
 */
const MARK_GLYPH: Record<TriggerChipKind, LucideIcon> = {
  received: Eye,
  claimed: Hand,
  // SVG 대체 요소가 다른 글리프와 같은 기준선·줄 높이를 지켜요.
  working: CircleDot,
  approval: ShieldQuestion,
  answered: Check,
  uncollected: CircleAlert,
  timed_out: Clock,
  failed: CircleX,
  declined: Ban,
  expired: Clock,
};

function MarkGlyph({ kind }: { kind: TriggerChipKind }) {
  const Glyph = MARK_GLYPH[kind];
  return <Glyph aria-hidden="true" className="size-3" />;
}

/**
 * 아이콘만 서는 층. `title`이 낱말을 툴팁으로 남긴다.
 *
 * 구조가 낱말 층의 `Face`와 **같은 모양**이다(격자 칸 → 줄 상자 안의 `inline-flex`): 줄 상자의 높이는 이 모양이 같을
 * 때만 같다(칩 높이 20 대 18을 실제 엔진에서 쟀다). 글리프는 한 변 12의 상자에 가운데로 앉아 점(8)과 아이콘(12)이
 * 같은 폭이 되고, 폭 0으로 접어 둔 **낱말 하나**(`w-0 overflow-hidden`)가 글꼴의 줄 높이를 낱말 칩과 같게 지킨다
 * (영폭 공백은 한글 글꼴의 줄 높이를 끌어오지 않는다). 글자는 보이지도 읽히지도 않는다.
 */
function MarkLayer({ chip, className }: { chip: TriggerChip; className: string }) {
  return (
    <span
      aria-hidden="true"
      title={chip.word}
      data-testid="trigger-chip-mark"
      className={cn("col-start-1 row-start-1", className)}
    >
      <span className="col-start-1 row-start-1 justify-self-center">
        <span className="inline-flex items-center justify-center whitespace-nowrap">
          <span className="inline-flex size-3 items-center justify-center">
            <MarkGlyph kind={chip.kind} />
          </span>
          <span className="w-0 overflow-hidden" data-testid="trigger-chip-mark-height">
            {chip.word}
          </span>
        </span>
      </span>
    </span>
  );
}

/**
 * 칩의 그림. 순수하다: 같은 입력이면 같은 마크업이고, 시험이 이 마크업을 그대로 실제 브라우저에
 * 올려 크기를 잰다.
 *
 * `variant`: `word`(기본)는 낱말 칩이고 `@container` 조상이 좁으면 아이콘만 남는다. `mark`는 처음부터
 * 아이콘 칩이다(거터). `reserve`가 거짓이면 격자에 다른 낱말을 겹치지 않는다(폭이 고정되지 않는다):
 * 스레드 요약 줄처럼 칩이 서고 지는 것이 이웃 글자를 움직이지 않는 자리에서만 쓴다.
 */
export function TriggerChipView({
  chip,
  onJump,
  variant = "word",
  reserve = true,
  onOpenBundle,
}: {
  chip: TriggerChip;
  onJump?: (answer: AnswerRef) => void;
  variant?: "word" | "mark";
  reserve?: boolean;
  onOpenBundle?: () => void;
}) {
  const className = cn(CHIP_CLASS, TRIGGER_CHIP_CLASS, TRIGGER_CHIP_TONE_CLASS[chip.tone]);
  const current = `${chip.word}|${chip.mark}`;
  const faces =
    variant === "mark" ? (
      <MarkLayer chip={chip} className="inline-grid" />
    ) : (
      <>
        <span className="col-start-1 row-start-1 inline-grid @max-sm:hidden">
          <span className="col-start-1 row-start-1 justify-self-center" data-testid="trigger-chip-word">
            <Face word={chip.word} mark={chip.mark} />
          </span>
          {reserve &&
            TRIGGER_CHIP_FACES.filter((face) => `${face.word}|${face.mark}` !== current).map((face) => (
              <span
                key={`${face.word}|${face.mark}`}
                aria-hidden="true"
                className="invisible col-start-1 row-start-1 justify-self-center"
                data-testid="trigger-chip-ghost"
              >
                <Face word={face.word} mark={face.mark} />
              </span>
            ))}
        </span>
        <MarkLayer chip={chip} className="hidden @max-sm:inline-grid" />
      </>
    );
  const answer = chip.answer;
  const opensBundle = onOpenBundle !== undefined;
  if (variant === "word" && (opensBundle || (answer !== undefined && onJump !== undefined))) {
    return (
      <button
        type="button"
        data-testid="trigger-chip"
        data-kind={chip.kind}
        data-row-action=""
        aria-label={opensBundle ? `${chip.label} 요청 스레드 열기` : `${chip.label} 답 메시지로 이동`}
        onClick={() => opensBundle ? onOpenBundle() : onJump?.(answer!)}
        // 누를 수 있는 면적만 4px씩 키운다(`after`): 20px 칩이 머리 줄에 끼어 있어 칩 자체를 키우면 행 높이가 변한다.
        // 28px로 WCAG 2.5.8의 24 바닥(웹 인라인 컨트롤)을 지키고, 그려지는 칩과 줄 높이는 그대로다.
        className={cn(className, "relative after:absolute after:-inset-1", "press hover:opacity-80 focus-visible:focus-ring")}
      >
        {faces}
      </button>
    );
  }
  return (
    <span
      role="img"
      aria-label={chip.label}
      data-testid="trigger-chip"
      data-kind={chip.kind}
      data-variant={variant}
      className={className}
    >
      {faces}
    </span>
  );
}

/**
 * 한 메시지가 일으킨 run들 → 칩. 칩에 올릴 run이 없으면 null이다.
 *
 * 「받음」이 「아직 받지 않았어요」로 넘어가는 유예 마감에 **한 번만** 다시 그린다(`useRerenderAt`): 칩은
 * 경과를 말하지 않으므로 매초 도는 시계가 필요 없다.
 */
function useTriggerChip(
  runs: readonly AgentRunProgress[],
  directory: Directory,
  runAnswers?: ReadonlyMap<string, AnswerRef>
): TriggerChip | null {
  const nowMs = useRerenderAt(nextUncollectedDeadlineMs(runs, Date.now()));
  return triggerChip(
    runs,
    (memberId) => memberNameParts(directory, memberId, UNKNOWN_AGENT_NAME),
    nowMs,
    runAnswers === undefined ? {} : { answerFor: (run) => runAnswers.get(run.id.toLowerCase()) }
  );
}

/** 머리 줄(이름 · 시각 옆)의 칩. 좁은 줄에서는 아이콘만 남는다. */
export function MessageTriggerChip({
  runs,
  directory,
  runAnswers,
  onJump,
  onOpenBundle,
}: {
  runs: readonly AgentRunProgress[];
  directory: Directory;
  /** run id(소문자) → 그 run의 답 메시지. 목록이 한 번 계산해 행에 넘긴다. */
  runAnswers?: ReadonlyMap<string, AnswerRef>;
  /** 「답함」을 눌렀을 때 답 메시지로 간다(`onJumpToMessage`). */
  onJump?: (messageId: string, seq: number | null) => void;
  onOpenBundle?: () => void;
}) {
  const chip = useTriggerChip(runs, directory, runAnswers);
  if (chip === null) return null;
  const selectedRun = runs.find((run) => chip.runIds.includes(run.id));
  const bundle = selectedRun ? runBundleSnapshot(selectedRun) : undefined;
  const namedChip = bundle?.intent && selectedRun ? { ...chip, label: `${memberNameParts(directory, selectedRun.agentMemberId, UNKNOWN_AGENT_NAME).name} ${chip.word}: ${bundle.intent}` } : chip;
  return (
    <TriggerChipView
      chip={namedChip}
      {...(bundle && onOpenBundle ? { onOpenBundle } : {})}
      {...(onJump !== undefined
        ? { onJump: (answer: AnswerRef) => onJump(answer.id, answer.seq) }
        : {})}
    />
  );
}

/**
 * 머리 줄이 없는 **이어지는 행**의 칩 (#4619 planner 결정 2). 같은 사람의 연속 메시지에는 이름·시각 줄이 없어
 * 칩이 설 머리가 없다. 그 행의 시각이 서는 거터 칸(hover하면 시각이 서는 그 자리)에 아이콘 칩을 둔다.
 * 거터의 부모는 이미 `relative`이고 시각이 `absolute`로 거터 밖까지 흘러나가듯 이 칩도 `absolute`라서 **행의
 * 높이도 본문의 자리도 한 픽셀 움직이지 않는다**. 거터는 칩 하나가 서기엔 충분하다(칩 28px < 거터 32px).
 *
 * 행에 포인터가 오거나 포커스가 들어오면 이 칩은 **시각에 자리를 내준다**(`group-hover:opacity-0`): 같은 자리에
 * 서는 두 글자를 겹쳐 두면 둘 다 못 읽는다. 시각이 늘 서 있는 기기(hover 없음, `data-row-clock`)에서는
 * 칩을 세우지 않는다(`tokens.css`의 `[data-row-chip]`): 자리가 하나뿐이고 그것은 시각의 것이다 — 그 행의
 * 상태는 입력창 레일과 예외 줄이 말한다.
 */
export function GutterTriggerChip({
  runs,
  directory,
}: {
  runs: readonly AgentRunProgress[];
  directory: Directory;
}) {
  const chip = useTriggerChip(runs, directory);
  if (chip === null) return null;
  return (
    <span
      data-row-chip=""
      className={cn(
        // `pointer-events-none`: 행에 포인터가 오면 이 칩은 시각에 자리를 내준다(opacity 0). 숨은 칩이 시각 위의 최상단으로
        // 남으면 시각에 포인터를 올릴 때 칩의 툴팁이 뜬다(design-review r1 Nitpick). 거터 칩은 어차피 눌리지 않는다.
        "pointer-events-none absolute right-0 top-px",
        "transition-opacity group-hover:opacity-0 group-focus-within:opacity-0",
        // 움직임을 줄여 달라고 한 사람에게는 페이드도 움직임이다.
        "motion-reduce:transition-none"
      )}
    >
      <TriggerChipView chip={chip} variant="mark" />
    </span>
  );
}

/**
 * 스레드 요약 줄(「답글 N개 · 마지막 …」) 곁의 「작업 중」 칩 (#4619 E). 같은 모델·같은 칩이다. 루트 메시지가 일으킨 run에만
 * 서고(누가 불렀든), 답글이 일으킨 run은 진행 읽기에 루트 id가 없어 닿지 못한다.
 * 일이 **진행 중**(가져감·작업 중)일 때만 선다: 끝난 일의 「답함」이나 실패는 머리 줄의 칩이 말하고,
 * 이 줄은 「이 스레드에서 지금 에이전트가 일하는 중」만 말한다. 누르는 것이 아니다. 폭은 고정하지 않는다
 * (`reserve={false}`): 이 줄의 칩은 맨 끝이라 서고 져도 이웃 글자가 움직이지 않는다.
 */
export function ThreadWorkChip({
  runs,
  directory,
}: {
  runs: readonly AgentRunProgress[];
  directory: Directory;
}) {
  const chip = useTriggerChip(runs, directory);
  if (chip === null || (chip.kind !== "working" && chip.kind !== "claimed")) return null;
  return (
    <span data-testid="thread-work-chip">
      <TriggerChipView chip={chip} reserve={false} />
    </span>
  );
}
