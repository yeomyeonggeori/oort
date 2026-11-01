import { useId, useRef, useState } from "react";
import { Check, Circle, CircleCheck, CircleDashed, ListChecks } from "lucide-react";
import {
  WORK_PLAN_SURFACE,
  workPlanCopy,
  workPlanStepWord,
  type WorkPlanProgress,
} from "@momo/core/features/work/workPlan";
import { Popover, PopoverContent, PopoverTrigger } from "@/design/ui/popover";
import { Select } from "@/design/ui/select";
import { Tooltip } from "@/design/ui/tooltip";
import { useSurfaceProvidedWhileOpen } from "@/features/capabilities/useSurfaceProvided";
import { closeWorkPanel } from "@/features/agents/workLogStore";
import { channelHeaderControlClass } from "@/features/chat/channelHeaderControl";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import type { OpenWorkSession } from "./openWorkSession";
import { useChannelWorkPlan } from "./useChannelWorkPlan";

// =============================================================================
// 대화 머리 오른쪽의 「계획 독」 (#4578, 계획 이슈 #4577 A1, 레퍼런스: Leverage Sessions Activity Dock의
// Plan 팝오버). 이 대화에서 지금 돌거나 마지막으로 돈 작업 세션이 알린 계획을 한 단추로 보인다:
//
//   [☰ 2]  →  계획 · 4단계 중 2단계
//             ✓ 코어 모델 읽기
//             ✓ 독 만들기
//             ◌ 시험 쓰기      (지금 단계: 굵게, 점선 원 — 움직이지 않는다)
//             ○ 캡처 장면 적기
//             [모두 보기]
//
// - **서는 때가 좁다.** 계획이 있는 세션이 있을 때만 선다(코어 `workPlanProgress`가 null이면 이 컴포넌트는
//   null이다). 자리표시자도 「계획 없음」 문장도 없다. 변경·PR 아이콘과 오른쪽 탭 패널은 owner가 이번 묶음에서
//   잘라냈다(2026-10-26): 「모두 보기」는 **기존 작업 세션 패널**의 세션 상세로 간다(거기에 계획 칸이 이미 있다).
//   새 상세 화면을 만들지 않는다.
// - 단추 안의 숫자는 **남은 단계 수**다(레퍼런스의 남은 수 배지). 다 끝나면 숫자 대신 체크다. 배지는 새 대비
//   쌍을 만들지 않으려고 중립 그릇(`bg-muted-soft`)이고, 신호색(`--signal`)은 이 표면에 쓰지 않는다.
// - 팝오버 머리의 「N단계 중 M단계」는 끝난 단계 수(M)다. 「지금 단계」는 서버가 running이라고 말하는 세션에서만
//   선다: 멈춘 세션은 한 줄(「지금은 돌고 있지 않아요」)로 정직하게 말한다.
// - 움직임이 없다(새 모션 0). 지금 단계의 점선 원은 **정적 표지**다: 점선 스피너를 돌리지 않는다.
// - 클래스는 정적 문자열이고 달라지는 색은 `data-*` 변형이 고른다(직접 문구 장부가 JSX 식 안의 문자열을 문구
//   후보로 세기 때문이다). 모든 문구는 사전(`timeline.workPlan.*`)을 거친다.
// - 계획 글은 호스트가 쓴 믿지 않는 일반 텍스트다. 텍스트 노드로만 그리고 긴 한 덩어리는 열 안에서 꺾는다.
// =============================================================================

export interface WorkPlanDockViewProps {
  progress: WorkPlanProgress;
  /** 고르는 목록. 둘 이상이면 팝오버 머리에 선택이 선다. */
  options: readonly { id: string; label: string }[];
  selectedId: string;
  maybeStale: boolean;
  onSelect: (id: string) => void;
  /** 「모두 보기」: 기존 작업 세션 화면을 연다. */
  onOpenAll: () => void;
}

/** 독의 그림. 순수하다: 같은 입력이면 같은 마크업이다(시험이 이 마크업을 그대로 올린다). */
export function WorkPlanDockView({
  progress,
  options,
  selectedId,
  maybeStale,
  onSelect,
  onOpenAll,
}: WorkPlanDockViewProps) {
  const formatMessage = useFormatMessage();
  const [open, setOpen] = useState(false);
  // 「모두 보기」가 다른 표면을 연 뒤에는 캐럿이 그쪽에 있어야 한다: 팝오버가 닫히며 단추로 돌려주지 않는다.
  const handedOff = useRef(false);
  const titleId = useId();
  const copy = workPlanCopy(progress, { maybeStale }, formatMessage);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* 툴팁은 트리거 **바깥**이고 방향은 아래다(머리 단추 규칙, #4591). 이름과 툴팁이 같은 글이다. */}
      <Tooltip label={copy.button} side="bottom">
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={copy.button}
            data-testid="work-plan-dock"
            data-remaining={progress.remaining}
            className={channelHeaderControlClass({ wide: !progress.allDone })}
          >
            {progress.allDone ? (
              <CircleCheck className="size-4 text-ok" aria-hidden="true" />
            ) : (
              <>
                <ListChecks className="size-4" aria-hidden="true" />
                <span
                  className="rounded-full bg-muted-soft px-1 text-timestamp text-ink"
                  data-numeric
                  data-testid="work-plan-remaining"
                >
                  {progress.remaining}
                </span>
              </>
            )}
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={8}
        // `popover-fit`: 폭 고정이 좁은 창에서 화면 밖으로 나가지 않게 Radix가 주는 남은 폭에 묶는다.
        className="popover-fit p-2"
        data-testid="work-plan-popover"
        // 열리면 보조기술이 제목(「계획 · 4단계 중 2단계」)을 읽는다: 이름 없는 대화상자로 열리지 않는다.
        aria-labelledby={titleId}
        onCloseAutoFocus={(event) => {
          if (!handedOff.current) return;
          handedOff.current = false;
          event.preventDefault();
        }}
      >
        <h2
          id={titleId}
          className="px-2 pb-1 text-meta font-medium text-ink"
          data-numeric
          data-testid="work-plan-title"
        >
          {copy.title}
        </h2>
        {options.length > 1 && (
          <label className="flex flex-col gap-1 px-2 pb-2 text-timestamp text-ink-muted">
            {copy.sessionLabel}
            <Select
              value={selectedId}
              onChange={(event) => onSelect(event.target.value)}
              data-testid="work-plan-session-select"
            >
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>
        )}
        <ol
          aria-labelledby={titleId}
          className="flex max-h-pane flex-col overflow-y-auto"
          data-testid="work-plan-steps"
        >
          {progress.steps.map((step, index) => (
            <li
              key={`${index}-${step.content}`}
              data-step={step.state}
              data-testid="work-plan-step"
              className="flex items-start gap-2 px-2 py-1 text-meta text-ink data-[step=current]:font-medium data-[step=done]:text-ink-muted"
            >
              {step.done ? (
                <Check className="size-4 shrink-0 text-ok" aria-hidden="true" />
              ) : step.current ? (
                <CircleDashed className="size-4 shrink-0 text-warn" aria-hidden="true" />
              ) : (
                <Circle className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 break-keep break-words">{step.content}</span>
              <span className="sr-only">{workPlanStepWord(step, formatMessage)}</span>
            </li>
          ))}
        </ol>
        {copy.notes.map((note) => (
          <p
            key={note}
            className="px-2 pt-1 text-timestamp text-ink-muted"
            data-testid="work-plan-note"
          >
            {note}
          </p>
        ))}
        <div className="mt-1 flex border-t border-line pt-1">
          <button
            type="button"
            data-testid="work-plan-open-all"
            className="tap-target rounded-md px-2 py-1 text-meta font-medium text-ink press hover:bg-surface-hover focus-visible:focus-ring"
            onClick={() => {
              handedOff.current = true;
              setOpen(false);
              onOpenAll();
            }}
          >
            {copy.openAll}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * 대화 머리가 꽂는 독. 이 채널의 작업 세션 계획을 읽어(`useChannelWorkPlan`) 있을 때만 선다.
 *
 * 작업 표면이 없는 서버·온라인 호스트가 없는 워크스페이스에서는 세션도 계획도 없으므로 **읽는 훅을 마운트하지도
 * 않는다**(`SurfaceGate`와 같은 판정, 유예 포함: 호스트 heartbeat가 한 번 흔들려도 독이 깜박이지 않는다).
 * 문을 이 컴포넌트에 두고 읽기를 안쪽 컴포넌트에 둔 이유다: 셀프호스트 기본 서버에서 머리가 쿼리·구독을 하나도 더
 * 열지 않는다.
 */
export function WorkPlanDock(props: {
  workspaceId: string;
  channelId: string;
  /** ChatShell의 `openWorkSession`: 기존 작업 세션 패널을 이 세션으로 연다. */
  onOpenSession: OpenWorkSession;
}) {
  const provided = useSurfaceProvidedWhileOpen(WORK_PLAN_SURFACE);
  return provided ? <ConnectedWorkPlanDock {...props} /> : null;
}

function ConnectedWorkPlanDock({
  workspaceId,
  channelId,
  onOpenSession,
}: {
  workspaceId: string;
  channelId: string;
  onOpenSession: OpenWorkSession;
}) {
  const plan = useChannelWorkPlan(workspaceId, channelId);
  if (plan === null) return null;
  return (
    <WorkPlanDockView
      progress={plan.progress}
      options={plan.options}
      selectedId={plan.selectedId}
      maybeStale={plan.maybeStale}
      onSelect={plan.select}
      onOpenAll={() => {
        // 같은 오른쪽 자리를 쓰는 에이전트 작업 패널이 열려 있으면 작업 세션 패널이 서지 못한다.
        closeWorkPanel();
        onOpenSession(plan.selectedId);
      }}
    />
  );
}
