import { describe, expect, it } from "vitest";
import type { Message } from "../../lib/api";
import { isAmbientMessage } from "./ambientMessage";
import golden from "./__fixtures__/dm-readable-message.golden.json";

// =============================================================================
// 규칙 드리프트 골든, 코어 쪽 (#4227, ADR-0177 증보 D9).
//
// 「읽을 메시지」와 「기계 메시지」의 구별은 두 곳에 한 벌씩 있다: 이 패키지의 `isAmbientMessage`(클라이언트가 메시지를
// 읽어 가르는 쪽)와 Postgres 트리거 `message_last_readable_seq_trg`(서버가 channel_seq.last_readable_seq 를 올리는
// 쪽, server/Migrations/146_dm_closure.sql). 한쪽만 바뀌면 같은 DM 이 기기마다 다르게 보인다. 두 구현이 공유하는 기대값은
// `__fixtures__/dm-readable-message.golden.json` 한 파일이고 사본이 없다: 여기서는 `core` 칸을 재고, Rust 격리 PG 시험
// (`dm_closure_conformance_pg.rs`)이 같은 파일의 `trigger` 칸을 실제 트리거에 넣어 잰다. 이 파일은 코어 안에 있다 — 코어
// 순수성 게이트는 패키지 밖 파일 읽기를 막으므로, Rust 가 이 경로를 읽는다.
// =============================================================================

interface GoldenShape {
  name: string;
  type: string;
  state: string;
  props: unknown;
  core: string;
  trigger: string;
}

const shapes: readonly GoldenShape[] = golden.shapes;

function asMessage(shape: GoldenShape): Pick<Message, "type" | "props" | "state"> {
  // 골든의 type·state 는 서버 enum 철자 그대로의 문자열이다. 코어 타입의 리터럴 유니온에 맞춰 읽는다.
  return { type: shape.type, state: shape.state, props: shape.props } as unknown as Pick<
    Message,
    "type" | "props" | "state"
  >;
}

describe("DM 읽을 메시지 골든 (ADR-0177 D9) — 코어 쪽", () => {
  it.each(shapes.map((shape) => [shape.name, shape] as const))(
    "%s: isAmbientMessage 가 골든의 core 기대와 같다",
    (_name, shape) => {
      expect(["readable", "ambient"]).toContain(shape.core);
      expect(isAmbientMessage(asMessage(shape)) ? "ambient" : "readable").toBe(shape.core);
    }
  );

  it("규칙이 틀리기 쉬운 모양을 담고 있다: kind 없는 보통 메시지, kind 가 NULL 로 읽히는 모양, 삭제됨", () => {
    const names = new Set(shapes.map((shape) => shape.name));
    expect(names.size).toBe(shapes.length);
    // 서버 트리거가 `<>` 로 비교하면 첫째 모양에서 빨개진다(NULL 함정).
    expect(names.has("plain-text-without-kind")).toBe(true);
    expect(names.has("text-with-null-kind")).toBe(true);
    expect(names.has("text-with-work-session-kind")).toBe(true);
    expect(names.has("deleted-text")).toBe(true);
  });

  it("삭제됨을 뺀 모든 모양에서 코어와 트리거의 기대가 같다 — 다르면 그것이 곧 드리프트다", () => {
    for (const shape of shapes) {
      if (shape.state === "deleted") {
        // 알려진 차이: 트리거는 INSERT 시점이라 삭제를 볼 수 없다. 코어는 삭제된 글을 기계로 본다.
        expect(shape.trigger).toBe("n/a(insert-time)");
        expect(shape.core).toBe("ambient");
      } else {
        expect(shape.trigger, shape.name).toBe(shape.core);
      }
    }
  });
});
