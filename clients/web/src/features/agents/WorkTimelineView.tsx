import type { ReactNode } from "react";
import {
  workTimelineRowCopy,
  workTimelineSourceLabel,
  workTimelineSourceNote,
  workToolSummaryText,
  type WorkTimelineRow,
  type WorkTimelineSection,
  type WorkTimelineSource,
  type WorkToolRecord,
} from "@momo/core/features/agents/workTimeline";
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
// - 새 모션이 없다. 줄이 제자리에서 바뀌는 움직임은 #4657이 정한다.
// - 모든 문구는 사전(`timeline.workRecord.*`)을 거친다. 클래스는 정적 문자열이고 달라지는 색은
//   `data-*` 변형이 고른다(직접 문구 장부가 JSX 식 안의 문자열을 문구 후보로 세기 때문이다).
// =============================================================================

export function WorkTimelineRows({
  rows,
  nowMs,
}: {
  rows: readonly WorkTimelineRow[];
  /** 오늘이 아닌 줄에 날짜를 붙이는 기준. */
  nowMs: number;
}) {
  const formatMessage = useFormatMessage();
  return (
    <ol className="flex flex-col" data-testid="work-timeline-rows">
      {rows.map((row) => {
        const copy = workTimelineRowCopy(row, formatMessage, nowMs);
        return (
          <li
            key={row.id}
            className="flex flex-col gap-1 border-b border-line px-4 py-2"
            data-testid="work-timeline-row"
            data-source={row.source}
            data-kind={row.kind}
            data-status={row.status}
            data-count={row.count}
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
                  className="shrink-0 rounded-sm bg-muted-soft px-1 text-timestamp text-ink-muted data-[status=failed]:bg-danger-soft data-[status=failed]:text-danger data-[status=running]:bg-agent-soft data-[status=running]:text-agent"
                  data-status={row.status}
                  data-testid="work-timeline-status"
                >
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
  testId = "work-timeline-section",
  children,
}: {
  source: WorkTimelineSource;
  rows: readonly WorkTimelineRow[];
  nowMs: number;
  testId?: string;
  /** 줄 앞에 서는 칸의 상태 문장(합계·빈 칸·구 서버). */
  children?: ReactNode;
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
      {rows.length > 0 && <WorkTimelineRows rows={rows} nowMs={nowMs} />}
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
