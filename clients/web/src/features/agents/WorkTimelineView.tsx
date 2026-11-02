import { useId, useRef, type ReactNode } from "react";
import { Check, Circle, CircleDashed } from "lucide-react";
import {
  lastRunningRowId,
  workTimelineRowCopy,
  workTimelineSourceLabel,
  workTimelineSourceNote,
  workToolSummaryText,
  type WorkTimelineRow,
  type WorkTimelineSection,
  type WorkTimelineSource,
  type WorkToolRecord,
} from "@momo/core/features/agents/workTimeline";
import {
  workActivityTallyText,
  type WorkActivityRecord,
} from "@momo/core/features/agents/workReport";
import {
  workPlanCopy,
  workPlanStepWord,
  type WorkPlanProgress,
} from "@momo/core/features/work/workPlan";
import { usePrefersReducedMotion } from "@/design/hooks/usePrefersReducedMotion";
import { useFormatMessage } from "@/i18n/useFormatMessage";

// =============================================================================
// 작업 타임라인의 칸과 줄 (#4654, 규칙은 core `workTimeline`). 이 파일은 그것을 320px 열에 그리는
// 일뿐이다: 무엇을 접고(읽기·검색 묶음, 같은 호출 반복) 무엇을 개별 줄로 세우는지, 칸을 출처마다
// 어떻게 가르는지, 문장이 무엇인지는 전부 core가 정한다.
//
// - **칸은 출처마다 하나다.** 칸 머리의 배지(oort 기록·에이전트 보고·내 컴퓨터)가 이 칸의 내용을
//   누가 말하는지 알린다. 한 칸에 두 출처의 줄이 서지 않는다(`WorkTimelineSections`는 core가 가른
//   칸을 그대로 그린다).
// - 에이전트·하네스가 쓴 글(`label`)은 **믿지 않는 일반 텍스트**다. 텍스트 노드로만 그린다.
// - 모든 문구는 사전(`timeline.workRecord.*`)을 거친다. 클래스는 정적 문자열이고 달라지는 색은
//   `data-*` 변형이 고른다(직접 문구 장부가 JSX 식 안의 문자열을 문구 후보로 세기 때문이다).
//
// ## 모션 (#4657, A1-U2). 새 값을 만들지 않고 기존 사다리(`motion.css`)만 쓴다.
//
// 1. **새 행**: 불투명도만 `--motion-standard`(240ms)로 선다(`motion-enter`). 이동 없음(transform 없음).
//    화면을 처음 그릴 때 이미 있던 행은 움직이지 않는다: 새로 도착한 행만이다(`useArrivedIds`).
// 2. **상태 변화**(진행 → 끝남·실패): **같은 행**(같은 id = 같은 DOM 노드)에서 칩의 색만 `--motion-instant`
//    (120ms)로 바뀐다. 행을 다시 끼우지 않는다.
// 3. **움직이는 건 하나**: 진행 중인 **마지막** 행의 점 하나(불투명도 루프, `responding-dot`). 연결이 끊기거나
//    서버가 「지금 돈다」고 말하지 않으면 점도 걷힌다(`live`). 다른 진행 중 행은 정지다.
// 4. **숫자**: 시각은 「14:05」, 개수는 `tabular-nums`(`data-numeric`)로 폭이 고정이고 초 단위 숫자도
//    카운트업도 없다.
// 5. **동작 줄이기**: 사다리 값이 0ms가 되고(`motion.css` D9) 점은 멈춘 채 선다.
// 6. **행이 붙어도 위 행은 움직이지 않는다**: 줄은 시간순(오래된 것이 위)이고 새 줄은 맨 아래에 붙으며, 줄
//    **위**에는 행이 붙을 때 달라지는 것이 없다(합계는 줄 **아래**다). 이동 0은 브라우저 시험이 잰다.
// =============================================================================

/**
 * 처음 그릴 때 없던 id를 모은다. 한 번 모이면 그 행이 마운트된 동안 남는다: 도착 직후 다시 그려져도
 * 불투명도 전환이 끊기지 않는다. 마운트될 때 이미 있던 행(화면을 열었을 때의 기록)은 모이지 않는다.
 */
function useArrivedIds(ids: readonly string[]): ReadonlySet<string> {
  const initial = useRef<ReadonlySet<string> | null>(null);
  const arrived = useRef<Set<string>>(new Set());
  if (initial.current === null) initial.current = new Set(ids);
  for (const id of ids) {
    if (!initial.current.has(id)) arrived.current.add(id);
  }
  return arrived.current;
}

/**
 * 진행 중인 마지막 행의 점 하나. 동작 줄이기에서는 멈춘 채 선다(곁의 「진행 중」 낱말이 상태를 말한다).
 *
 * **점은 흐름 밖(절대 위치)이다.** 칩 안의 첫 항목으로 두면 칩의 기준선이 점의 바닥으로 바뀌어 점이 서고 질 때
 * 줄 높이가 1px 흔들린다(브라우저 시험이 잡았다). 자리는 진행 중 칩의 왼쪽 여백(`pl-3`)이 점이 있든 없든 늘
 * 예약하므로 점이 오가도 줄의 어떤 값도 달라지지 않는다.
 */
function RunningDot() {
  const reduced = usePrefersReducedMotion();
  return (
    <span
      aria-hidden="true"
      data-testid="work-timeline-dot"
      data-still={reduced ? "" : undefined}
      className="responding-dot absolute inset-y-0 left-1 my-auto size-1 rounded-full bg-agent data-still:animate-none data-still:opacity-60"
    />
  );
}

export function WorkTimelineRows({
  rows,
  nowMs,
  live = false,
}: {
  rows: readonly WorkTimelineRow[];
  /** 오늘이 아닌 줄에 날짜를 붙이는 기준. */
  nowMs: number;
  /**
   * 서버가 지금 돈다고 말하고 실시간 연결도 살아 있는가. 이때만 진행 중인 마지막 행에 점이 서고 「진행 중」 칩이
   * 에이전트색이다. 끊긴 화면은 마지막으로 확인된 상태라서 지금 하고 있다고 움직이지 않는다.
   */
  live?: boolean;
}) {
  const formatMessage = useFormatMessage();
  const arrived = useArrivedIds(rows.map((row) => row.id));
  const dotRowId = live ? lastRunningRowId(rows) : null;
  return (
    <ol className="flex flex-col" data-testid="work-timeline-rows">
      {rows.map((row) => {
        const copy = workTimelineRowCopy(row, formatMessage, nowMs);
        return (
          <li
            key={row.id}
            className="flex flex-col gap-1 border-b border-line px-4 py-2 data-arrived:motion-enter"
            data-testid="work-timeline-row"
            data-row-id={row.id}
            data-source={row.source}
            data-kind={row.kind}
            data-status={row.status}
            data-count={row.count}
            data-arrived={arrived.has(row.id) ? "" : undefined}
          >
            <div className="flex min-w-0 items-baseline gap-2">
              <span
                className="shrink-0 text-timestamp text-ink-muted"
                data-numeric
                data-testid="work-timeline-time"
              >
                {copy.time}
              </span>
              {/* 이름은 도구 낱말이거나 에이전트가 쓴 글이다. 텍스트 노드로만 그리고 긴 한 덩어리는 열 안에서 꺾는다. */}
              <span
                className="min-w-0 flex-1 break-keep break-words text-meta text-ink"
                data-testid="work-timeline-label"
              >
                {copy.label}
                {copy.repeat !== null && (
                  <span className="text-ink-muted" data-numeric data-testid="work-timeline-repeat">
                    {" "}· {copy.repeat}
                  </span>
                )}
              </span>
              {copy.statusWord !== null && (
                <span
                  className="relative shrink-0 rounded-sm bg-muted-soft px-1 text-timestamp text-ink-muted transition-colors data-[status=failed]:bg-danger-soft data-[status=failed]:text-danger data-[status=running]:pl-3 data-[status=running]:data-live:bg-agent-soft data-[status=running]:data-live:text-agent"
                  data-status={row.status}
                  data-live={live ? "" : undefined}
                  data-testid="work-timeline-status"
                >
                  {dotRowId === row.id && <RunningDot />}
                  {copy.statusWord}
                </span>
              )}
              {copy.duration !== null && (
                <span
                  className="shrink-0 text-timestamp text-ink-muted"
                  data-numeric
                  data-testid="work-timeline-duration"
                >
                  {copy.duration}
                </span>
              )}
            </div>
            {copy.failure !== null && (
              <p className="break-keep text-timestamp text-ink-muted" data-testid="work-timeline-failure">
                {copy.failure}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** 한 출처의 칸: 배지 머리 + 믿음의 정도를 말하는 한 줄 + (상태 문장) + 줄. */
export function WorkTimelineSectionView({
  source,
  rows,
  nowMs,
  live = false,
  testId = "work-timeline-section",
  children,
  footer,
}: {
  source: WorkTimelineSource;
  rows: readonly WorkTimelineRow[];
  nowMs: number;
  /** `WorkTimelineRows`의 `live`: 진행 중인 마지막 행의 점과 칩 색. */
  live?: boolean;
  testId?: string;
  /** 줄 앞에 서는 칸의 상태 문장(합계·빈 칸·구 서버). */
  children?: ReactNode;
  /**
   * 줄 **뒤**에 서는 것(끝난 활동 합계·상한 문장). 행이 붙을 때 달라지는 것이라 줄 위에 두면 위 행이 밀린다:
   * 줄은 시간순이고 새 줄은 맨 아래에 붙으므로, 줄이 바뀌면 달라지는 것은 모두 줄 아래에 선다.
   */
  footer?: ReactNode;
}) {
  const formatMessage = useFormatMessage();
  return (
    <section data-testid={testId} data-source={source}>
      <h3 className="px-4 pt-3 text-meta font-medium text-ink">
        <span
          className="inline-block rounded-md bg-muted-soft px-2 text-ink data-[source=agent]:bg-agent-soft data-[source=agent]:text-agent"
          data-source={source}
          data-testid="work-timeline-source-badge"
        >
          {workTimelineSourceLabel(source, formatMessage)}
        </span>
      </h3>
      <p
        className="break-keep px-4 pb-1 pt-1 text-timestamp text-ink-muted"
        data-testid="work-timeline-source-note"
      >
        {workTimelineSourceNote(source, formatMessage)}
      </p>
      {children}
      {rows.length > 0 && <WorkTimelineRows rows={rows} nowMs={nowMs} live={live} />}
      {footer}
    </section>
  );
}

/** core가 출처마다 가른 칸들을 그대로 그린다. #4657이 에이전트 보고·내 컴퓨터 행을 만들면 이 길로 선다. */
export function WorkTimelineSections({
  sections,
  nowMs,
}: {
  sections: readonly WorkTimelineSection[];
  nowMs: number;
}) {
  return (
    <>
      {sections.map((section) => (
        <WorkTimelineSectionView
          key={section.source}
          source={section.source}
          rows={section.rows}
          nowMs={nowMs}
        />
      ))}
    </>
  );
}

/**
 * 작업 패널의 「oort 기록」 칸: oort가 직접 잰 도구 호출(ADR-0200 증보 2026-10-15). 네 가지 상태가 다
 * 말이 있다. 구 서버(`include=tools`를 모름)는 「서버 업데이트 뒤에 보여요」, 호출이 아직 없으면
 * 「없어요」(열린 run과 끝난 run의 말이 다르다), 줄이 있으면 합계 한 줄 + 줄, 줄 상한을 넘었으면
 * 합계가 모두 센 값이라는 한 줄. 합계는 행 상한(100)을 넘은 호출까지 센 서버 값이다.
 */
export function OortRecordSection({
  record,
  open,
  nowMs,
}: {
  record: WorkToolRecord;
  /** 이 run이 아직 열려 있는가(빈 칸의 말이 달라진다). */
  open: boolean;
  nowMs: number;
}) {
  const formatMessage = useFormatMessage();
  // 호출이 0번이면 합계 줄은 서지 않는다: 빈 칸 문장이 이미 같은 말을 한다.
  const summary =
    record.tally !== null && record.tally.calls > 0
      ? workToolSummaryText(record.tally, formatMessage)
      : null;
  return (
    <WorkTimelineSectionView
      source="oort"
      rows={record.supported ? record.rows : []}
      nowMs={nowMs}
      testId="agent-work-panel-oort-record"
    >
      {!record.supported ? (
        <p
          className="break-keep px-4 py-2 text-meta text-ink-muted"
          data-testid="agent-work-panel-oort-unsupported"
        >
          {formatMessage("timeline.workRecord.unsupported")}
        </p>
      ) : (
        <>
          {summary !== null && (
            <p
              className="break-keep px-4 pb-1 text-meta text-ink"
              data-numeric
              data-testid="agent-work-panel-oort-summary"
            >
              {summary}
            </p>
          )}
          {record.rows.length === 0 && (
            <p
              className="break-keep px-4 py-2 text-meta text-ink-muted"
              data-testid="agent-work-panel-oort-empty"
            >
              {formatMessage(
                open ? "timeline.workRecord.emptyOpen" : "timeline.workRecord.emptyEnded"
              )}
            </p>
          )}
        </>
      )}
      {record.supported && record.capped && (
        <p
          className="break-keep px-4 py-2 text-timestamp text-ink-muted"
          data-testid="agent-work-panel-oort-capped"
        >
          {formatMessage("timeline.workRecord.capped", { shown: record.listedCalls })}
        </p>
      )}
    </WorkTimelineSectionView>
  );
}

/**
 * 에이전트가 계획으로 알린 단계 목록(ADR-0200 증보 7: 통째 교체되는 최신 계획). 완료는 체크, 지금 단계는 굵게 +
 * 점선 원(움직이지 않는다), 대기는 빈 원이고 **색과 모양과 낱말(sr-only)** 셋으로 갈린다. 단계는 같은 자리(index)에서
 * 상태만 바뀌므로 줄이 다시 끼워지지 않는다. 글은 에이전트가 쓴 믿지 않는 일반 텍스트라 텍스트 노드로만 그린다.
 */
function AgentPlanBlock({ plan }: { plan: WorkPlanProgress }) {
  const formatMessage = useFormatMessage();
  const titleId = useId();
  const copy = workPlanCopy(plan, { maybeStale: false }, formatMessage);
  return (
    <div className="px-4 pb-2" data-testid="agent-work-panel-plan">
      <h4
        id={titleId}
        className="pb-1 text-meta font-medium text-ink"
        data-numeric
        data-testid="agent-work-panel-plan-title"
      >
        {copy.title}
      </h4>
      <ol aria-labelledby={titleId} className="flex flex-col" data-testid="agent-work-panel-plan-steps">
        {plan.steps.map((step, index) => (
          <li
            // 계획은 통째로 바뀌므로 자리(index)가 열쇠다: 같은 자리의 단계는 같은 줄에서 상태만 바뀐다.
            key={index}
            data-step={step.state}
            data-testid="agent-work-panel-plan-step"
            className="flex items-start gap-2 py-1 text-meta text-ink transition-colors data-[step=current]:font-medium data-[step=done]:text-ink-muted"
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
      {!plan.live && !plan.allDone && (
        <p className="break-keep pt-1 text-timestamp text-ink-muted" data-testid="agent-work-panel-plan-note">
          {formatMessage("timeline.workReport.planNotLive")}
        </p>
      )}
    </div>
  );
}

/**
 * 작업 패널의 「에이전트 보고」 칸: 에이전트가 스스로 알린 활동과 계획(ADR-0200 증보 7 7-7, #4657). 서버가 잰 「oort
 * 기록」 칸과 **다른 칸**이다. 네 가지 상태가 다 말이 있다. 구 서버(`include=activity`를 모름)는 「서버 업데이트 뒤에
 * 보여요」, 알린 것이 없으면 「없어요」(열린 run과 끝난 run의 말이 다르다), 있으면 계획 블록 + 줄, 줄 아래에는 끝난
 * 활동 합계와 (줄이 합계보다 적을 때) 한 줄이 선다.
 *
 * 순서가 이동 0의 계약이다: 계획 블록은 줄 위, 합계·상한은 줄 아래. 줄이 붙을 때 달라지는 것은 모두 줄 아래라서
 * 위 행이 밀리지 않는다. 계획 블록은 계획이 **처음 도착할 때** 한 번 줄을 밀 수 있다(새 줄이 붙는 것이 아니라
 * 블록이 서는 것이고, 첫 보고 시각을 모르는 계획은 타임라인에 자리를 못 잡는다 — `workReport` 머리 5).
 */
export function AgentReportSection({
  record,
  open,
  live,
  nowMs,
}: {
  record: WorkActivityRecord;
  /** 이 run이 아직 열려 있는가(빈 칸의 말이 달라진다). */
  open: boolean;
  /** 서버가 지금 돈다고 말하고 연결도 살아 있는가(점·진행 중 칩의 색). */
  live: boolean;
  nowMs: number;
}) {
  const formatMessage = useFormatMessage();
  const tally = workActivityTallyText(record.tally, formatMessage);
  const empty = record.supported && record.rows.length === 0 && record.plan === null;
  return (
    <WorkTimelineSectionView
      source="agent"
      rows={record.supported ? record.rows : []}
      nowMs={nowMs}
      live={live}
      testId="agent-work-panel-agent-report"
      footer={
        record.supported && (tally !== null || record.trimmed) ? (
          <div className="flex flex-col gap-1 px-4 py-2">
            {tally !== null && (
              <p
                className="break-keep text-timestamp text-ink-muted"
                data-numeric
                data-testid="agent-work-panel-agent-tally"
              >
                {tally}
              </p>
            )}
            {record.trimmed && (
              <p className="break-keep text-timestamp text-ink-muted" data-testid="agent-work-panel-agent-trimmed">
                {formatMessage("timeline.workReport.trimmed")}
              </p>
            )}
          </div>
        ) : null
      }
    >
      {!record.supported ? (
        <p
          className="break-keep px-4 py-2 text-meta text-ink-muted"
          data-testid="agent-work-panel-agent-unsupported"
        >
          {formatMessage("timeline.workReport.unsupported")}
        </p>
      ) : (
        <>
          {record.plan !== null && <AgentPlanBlock plan={record.plan} />}
          {empty && (
            <p
              className="break-keep px-4 py-2 text-meta text-ink-muted"
              data-testid="agent-work-panel-agent-empty"
            >
              {formatMessage(open ? "timeline.workReport.emptyOpen" : "timeline.workReport.emptyEnded")}
            </p>
          )}
        </>
      )}
    </WorkTimelineSectionView>
  );
}
