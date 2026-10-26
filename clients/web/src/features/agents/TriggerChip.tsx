import { Check, CircleAlert } from "lucide-react";
import type { AgentRunProgress } from "@momo/core/lib/api";
import { nextUncollectedDeadlineMs } from "@momo/core/features/agents/runException";
import { UNKNOWN_AGENT_NAME } from "@momo/core/features/agents/turnCopy";
import {
  TRIGGER_CHIP_FACES,
  triggerChip,
  type AnswerRef,
  type TriggerChip,
  type TriggerChipMark,
  type TriggerChipTone,
} from "@momo/core/features/agents/triggerChip";
import { cn } from "@/design/lib/cn";
import { CHIP_CLASS } from "@/features/common/chip";
import { memberNameParts, type Directory } from "@/features/workspace/useWorkspace";
import { useRerenderAt } from "./useRerenderAt";

// =============================================================================
// 트리거 메시지의 상태 칩 (#4619, #4577 권장 B).
//
//   grok 오후 3:07  [받음]  →  [가져감]  →  [● 작업 중]  →  [✓ 답함]      [! 못 가져감]  [! 실패]
//
// 에이전트를 부른 내 메시지의 머리 줄(시각 옆)에 **크기가 고정된** 칩 하나가 선다. 문장 행(「받았어요
// → 깨우는 신호 보냄 → 가져감 → …」)을 대신한다. 한 낱말이라 상태가 바뀌어도 줄의 높이도 칩의 폭도
// 변하지 않는다.
//
// ## 크기 고정은 어떻게
//
// 칩 폭을 숫자로 못 박지 않고 **가장 넓은 낱말에 맞춘다**: 가능한 모든 (낱말, 표지) 조합을 같은
// 격자 칸에 겹쳐 두고 지금 것만 보이게 한다(나머지는 `invisible`, `aria-hidden`). 칩의 폭은 어느
// 낱말이 서 있든 가장 넓은 조합의 폭이고, 낱말이 번역으로 길어져도 따라간다(7개 언어, ADR-0213).
// 높이는 칩 기하(`CHIP_CLASS`)가 정한다. 시험이 실제 엔진에서 낱말을 갈아 끼우며 폭·높이를 잰다.
//
// ## 낱말과 모양
//
// 낱말과 상태 판정은 코어 `triggerChip`이 정한다(레일과 같은 낱말). 모양은 색에만 기대지 않는다:
// 점(작업 중)·체크(답함)·느낌표(못 가져감·실패). 그릇은 칩 그릇 규칙(`chipVessel.test`)의 넷
// (`muted/ok/warn/danger-soft`)만 쓴다.
//
// 「답함 ✓」은 답 메시지를 알 때만 눌리는 단추다(눌러도 갈 곳이 없는 단추를 세우지 않는다).
// =============================================================================

/** 톤 → 그릇과 글자. 짝은 `tokens.contrast.test`가 두 스킴에서 재는 것들이다. */
export const TRIGGER_CHIP_TONE_CLASS: Readonly<Record<TriggerChipTone, string>> = {
  muted: "bg-muted-soft text-ink-muted",
  working: "bg-muted-soft text-warn",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
};

/**
 * 칩 한 개의 바탕 클래스. 격자(`inline-grid`)가 겹쳐 놓은 낱말들 중 가장 넓은 것이 폭을 정한다.
 *
 * `self-center`가 높이를 지킨다: 머리 줄은 `items-baseline`이고, 칩의 기준선은 안에 아이콘이 있느냐에
 * 따라 갈린다(아이콘이 먼저면 아이콘 바닥이 기준선이다). 기준선 정렬로 두면 글자만 있는 칩(받음·가져감·
 * 승인 대기)은 줄을 1px, 점이 붙은 칩(작업 중)은 2px 키웠다 — 실제 엔진에서 잰 값이다. 가운데 정렬은
 * 칩 높이(18)가 줄(22) 안에 들어가는 한 낱말과 무관하게 줄 높이를 건드리지 않는다.
 */
export const TRIGGER_CHIP_CLASS = "inline-grid items-center self-center";

function Face({ word, mark }: { word: string; mark: TriggerChipMark }) {
  return (
    <span className="inline-flex items-center justify-center gap-1 whitespace-nowrap">
      {mark === "dot" && <span aria-hidden="true" className="size-1 rounded-full bg-warn" />}
      {mark === "check" && <Check aria-hidden="true" className="size-3" />}
      {mark === "alert" && <CircleAlert aria-hidden="true" className="size-3" />}
      {word}
    </span>
  );
}

/**
 * 칩의 그림. 순수하다: 같은 입력이면 같은 마크업이고, 시험이 이 마크업을 그대로 실제 브라우저에
 * 올려 크기를 잰다.
 */
export function TriggerChipView({
  chip,
  onJump,
}: {
  chip: TriggerChip;
  onJump?: (answer: AnswerRef) => void;
}) {
  const className = cn(CHIP_CLASS, TRIGGER_CHIP_CLASS, TRIGGER_CHIP_TONE_CLASS[chip.tone]);
  const current = `${chip.word}|${chip.mark}`;
  const faces = (
    <>
      <span className="col-start-1 row-start-1 justify-self-center" data-testid="trigger-chip-word">
        <Face word={chip.word} mark={chip.mark} />
      </span>
      {TRIGGER_CHIP_FACES.filter((face) => `${face.word}|${face.mark}` !== current).map((face) => (
        <span
          key={`${face.word}|${face.mark}`}
          aria-hidden="true"
          className="invisible col-start-1 row-start-1 justify-self-center"
          data-testid="trigger-chip-ghost"
        >
          <Face word={face.word} mark={face.mark} />
        </span>
      ))}
    </>
  );
  const answer = chip.answer;
  if (answer !== undefined && onJump !== undefined) {
    return (
      <button
        type="button"
        data-testid="trigger-chip"
        data-kind={chip.kind}
        data-row-action=""
        aria-label={`${chip.label} 답 메시지로 이동`}
        onClick={() => onJump(answer)}
        className={cn(className, "press hover:opacity-80 focus-visible:focus-ring")}
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
      className={className}
    >
      {faces}
    </span>
  );
}

/**
 * 한 메시지가 일으킨 run들 → 칩. 칩에 올릴 run이 없으면 아무것도 그리지 않는다.
 *
 * 「받음」이 「못 가져감」으로 넘어가는 유예 마감에 **한 번만** 다시 그린다(`useRerenderAt`): 칩은
 * 경과를 말하지 않으므로 매초 도는 시계가 필요 없다.
 */
export function MessageTriggerChip({
  runs,
  directory,
  runAnswers,
  onJump,
}: {
  runs: readonly AgentRunProgress[];
  directory: Directory;
  /** run id(소문자) → 그 run의 답 메시지. 목록이 한 번 계산해 행에 넘긴다. */
  runAnswers?: ReadonlyMap<string, AnswerRef>;
  /** 「답함」을 눌렀을 때 답 메시지로 간다(`onJumpToMessage`). */
  onJump?: (messageId: string, seq: number | null) => void;
}) {
  const nowMs = useRerenderAt(nextUncollectedDeadlineMs(runs, Date.now()));
  const chip = triggerChip(
    runs,
    (memberId) => memberNameParts(directory, memberId, UNKNOWN_AGENT_NAME),
    nowMs,
    { answerFor: (run) => runAnswers?.get(run.id.toLowerCase()) }
  );
  if (chip === null) return null;
  return (
    <TriggerChipView
      chip={chip}
      {...(onJump !== undefined
        ? { onJump: (answer: AnswerRef) => onJump(answer.id, answer.seq) }
        : {})}
    />
  );
}

/**
 * 스레드 요약 줄(「답글 N개 · 마지막 …」) 곁의 「작업 중」 칩 (#4619 E). 같은 모델·같은 칩이다.
 * 일이 **진행 중**(가져감·작업 중)일 때만 선다: 끝난 일의 「답함」이나 실패는 머리 줄의 칩이 말하고,
 * 이 줄은 「이 스레드에서 지금 에이전트가 일하는 중」만 말한다. 누르는 것이 아니다.
 */
export function ThreadWorkChip({
  runs,
  directory,
}: {
  runs: readonly AgentRunProgress[];
  directory: Directory;
}) {
  const nowMs = useRerenderAt(nextUncollectedDeadlineMs(runs, Date.now()));
  const chip = triggerChip(
    runs,
    (memberId) => memberNameParts(directory, memberId, UNKNOWN_AGENT_NAME),
    nowMs
  );
  if (chip === null || (chip.kind !== "working" && chip.kind !== "claimed")) return null;
  return (
    <span data-testid="thread-work-chip">
      <TriggerChipView chip={chip} />
    </span>
  );
}
