import type { Message } from "@momo/core/lib/api";
import { cn } from "@/design/lib/cn";
import { MARKER_DIVIDER_PAD_CLASS } from "./spacing";

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
// =============================================================================

export function SystemLine({
  message,
}: {
  message: Pick<Message, "id" | "seq" | "body">;
}) {
  return (
    <div
      data-testid="system-line"
      data-seq={message.seq}
      data-message-id={message.id.toLowerCase()}
      className={cn("flex justify-center px-4", MARKER_DIVIDER_PAD_CLASS)}
    >
      <p className="min-w-0 break-keep break-words text-balance text-center text-meta text-ink-muted">
        {message.body}
      </p>
    </div>
  );
}
