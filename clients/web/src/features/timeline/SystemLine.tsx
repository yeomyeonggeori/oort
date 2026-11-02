import type { Message } from "@momo/core/lib/api";
import { cn } from "@/design/lib/cn";
import { MARKER_DIVIDER_PAD_CLASS, SYSTEM_LINE_STRADDLE_CLEAR_CLASS } from "./spacing";

// =============================================================================
// 시스템 줄 (#5079, 폰 `SystemLine` #5067의 짝) — 방에 알리는 한 줄을 **누가 한 말처럼 그리지 않는다**.
//
// 서버는 사람이 에이전트 실행을 멈추면 `type: system`·`props.kind = agent_run_cancelled` 줄을 남기고(`routes/agent_runs.rs`),
// 작성자는 멈춘 사람이다. 에이전트도 사람도 한 말이 아니라 방에 알리는 줄인데, 일반 행으로 그리면 멈춘 사람의 아바타·이름·시각이
// 달려 「내가 쓴 글」처럼 붙었다. 이 부품은 **아바타도 이름도 시각도 없는** 가운데의 조용한 글줄이다 — 안 읽음·복구 표지가 서는
// 같은 자리(`MARKER_DIVIDER_PAD_CLASS`)에서 `text-ink-muted` 로 말한다. 행 동작(반응·답글·고치기·메뉴)의 대상도 아니다.
//
// 문장은 **서버가 준 본문 그대로**다. 낱말을 이 부품이 고쳐 쓰지 않는다(문장은 엔진 몫이다).
//
// 항법의 신원은 일반 행과 같은 속성(`data-seq`·`data-message-id`)으로 단다. 다만 `data-testid` 는 `system-line` 이다:
// `timeline-message` 는 「행 동작이 있는 메시지 행」의 이름이라(`rowFocus`·`hoverToolbarModel`·`inbox/anchor` 가 그 이름으로
// 행을 센다) 눌리지 않는 줄이 그 이름을 쓰면 정거장·툴바 판정이 이 줄을 행으로 센다. 그래서 seq 로 행에 착지하는 길
// (`focusRowStationBySeq`)은 이 줄을 겨냥하지 않는다 — 초점을 받을 곳이 없는 줄이므로 맞는 동작이다.
//
// 큰 글씨·긴 문장: 어절 단위로 넘어가고(`break-keep`) 줄이 둘이 되면 길이를 맞춘다(`text-balance`) — 가운데에 서는 글줄이
// 한 어절만 다음 줄로 흘리지 않는다.
//
// 이웃 행의 호버 툴바와 겹치지 않는다 (#5173, README §6 행 액션 5번). 툴바는 행 위 경계(스크롤러 맨 위에서는 아래 경계)를 걸쳐 이웃 칸
// 위에 `42 − row`(34~38)만큼 얹히는데, 가운데 글줄은 높이 34라 좁은 열(툴바 왼쪽 끝이 글자 오른쪽 끝보다 왼쪽인 열)에서는 통째로 그 밑에
// 선다. 그래서 툴바가 서는 표면(`clearsToolbarBand`, 타임라인)에서 **호버가 되는 입력의 좁은 열에서만** 글줄 위·아래를 글자 상자 기준
// 41·42까지 비운다(`SYSTEM_LINE_STRADDLE_CLEAR_CLASS`, 산식은 `spacing.ts`). 넓은 열이나 손가락 기기, 툴바가 없는 받은 편지함 맥락 창에서는
// 줄이 34 그대로 조용하다. 문턱은 뷰포트가 아니라 **이 줄의 열 폭**이라 루트가 컨테이너(`@container`)다 — 컨테이너는 자기 자손의
// 규칙만 고르므로 여유는 글줄을 감싼 안쪽 상자가 진다.
// =============================================================================

/** 글줄을 감싼 안쪽 상자: 줄어들 수 있다(`min-w-0`). */
const SENTENCE_BOX_CLASS = "min-w-0";
/** 이웃 행에 호버 툴바가 서는 표면(타임라인)의 상자: 좁은 열에서는 툴바 straddle 띠를 위·아래 여유로 비운다. */
const SENTENCE_BOX_CLEAR_CLASS = cn(SENTENCE_BOX_CLASS, SYSTEM_LINE_STRADDLE_CLEAR_CLASS);

export function SystemLine({
  message,
  clearsToolbarBand = false,
}: {
  message: Pick<Message, "id" | "seq" | "body">;
  /** 이웃 행이 호버 툴바를 띄우는 표면(타임라인)이면 true. 툴바가 없는 표면(받은 편지함 맥락 창)은 비워 두어 34 그대로 둔다. */
  clearsToolbarBand?: boolean;
}) {
  return (
    <div
      data-testid="system-line"
      data-seq={message.seq}
      data-message-id={message.id.toLowerCase()}
      className={cn("@container flex justify-center px-4", MARKER_DIVIDER_PAD_CLASS)}
    >
      <div className={clearsToolbarBand ? SENTENCE_BOX_CLEAR_CLASS : SENTENCE_BOX_CLASS}>
        <p className="min-w-0 break-keep break-words text-balance text-center text-meta text-ink-muted">
          {message.body}
        </p>
      </div>
    </div>
  );
}
