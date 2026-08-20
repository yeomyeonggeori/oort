import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPOSER_OFFLINE_COPY } from "./Composer";
import { COMPOSER_OFFLINE_COPY as CORE_COPY } from "@momo/core/features/chat/composerCopy";

// =============================================================================
// U4-6 리뷰 H-1 — 컴포저의 오프라인 문장은 **두 클라가 같은 것**이다.
//
// 리뷰가 실측한 것: 같은 주에 랜딩한 두 배치가 각자 `COMPOSER_OFFLINE_COPY` 라는
// 같은 이름을 짓고 다른 문장을 넣었다. 이 파일이 지키는 것은 「문장이 예쁘다」가
// 아니라 **이 클라가 자기 문장을 다시 갖지 않는다**이다.
//
// 폰 쪽 짝은 `clients/mobile/__tests__/composerDraftOffline.test.tsx` 이고, 값의
// 모양은 `packages/momo-core/src/features/chat/composerCopy.test.ts` 가 잰다.
// =============================================================================

const COMPOSER_SRC = readFileSync(
  fileURLToPath(new URL("./Composer.tsx", import.meta.url)),
  "utf8"
);

/** 주석을 걷어낸 코드. 문장이 **주석에** 인용되는 것은 갈라짐이 아니다. */
const CODE_ONLY = COMPOSER_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /^\s*\/\/.*$/gm,
  ""
);

describe("컴포저 오프라인 문장이 한 벌이다 (H-1)", () => {
  it("이 파일이 내보내는 것이 코어의 값 그대로다", () => {
    expect(COMPOSER_OFFLINE_COPY).toBe(CORE_COPY);
  });

  it("문장을 손으로 적은 자리가 없다 — 이름만 든다", () => {
    expect(CODE_ONLY).not.toContain("연결이 끊겨 지금은 보낼 수 없습니다");
    // 앞 판의 문장. 되돌아오면 여기서 빨강이다.
    expect(CODE_ONLY).not.toContain("쓰던 글은 그대로 남습니다");
    expect(CODE_ONLY).toContain(
      'from "@momo/core/features/chat/composerCopy"'
    );
  });

  it("게이트도 조각을 손으로 적지 않는다 — 코어를 읽는다", () => {
    // 게이트가 문장 조각을 들고 있으면, 문장이 고쳐지는 날 게이트가 그 수리를
    // 막는다. 실제로 이 리뷰에서 그럴 뻔했다.
    const gate = readFileSync(
      fileURLToPath(new URL("../../../gates/gate-composer.mjs", import.meta.url)),
      "utf8"
    );
    expect(gate).toContain("features/chat/composerCopy.ts");
    const gateCode = gate
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(gateCode).not.toContain("쓰던 글은 그대로 남습니다");
  });
});

// =============================================================================
// #1384 CRUN-3 — 빈 컴포저의 광고와 키 힌트도 같은 규칙 아래로 들어왔다.
//
// 오프라인 문장이 코어로 올라간 뒤에도 **플레이스홀더는 두 클라가 각자 적고**
// 있었다: 웹 `Composer.tsx` 와 폰 `conversation/Composer.tsx` 가 나란히
// `` `${channelLabel}에 메시지 보내기` `` 를 들고 있었고, 스레드 컴포저 둘은
// `"답글 쓰기"` 를 각자 들고 있었다. 값이 같아서 안 보였을 뿐, 한쪽을 고치는 날
// 갈라진다 — 그리고 이 티켓이 정확히 웹 쪽을 고쳤다.
//
// 그래서 이 스위트는 오프라인 문장에 걸어 둔 그 규칙(**이 클라는 자기 문장을
// 다시 갖지 않는다**)을 새 문자열들에도 그대로 건다.
// =============================================================================

function codeOf(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8"
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("컴포저 카피가 한 벌이다 (#1384)", () => {
  it("플레이스홀더와 필드 이름을 손으로 짓지 않는다", () => {
    // 앞 판: placeholder={`${channelLabel}에 메시지 보내기`} — 조사까지 손으로
    // 적혀 있었고, 그래서 DM 에서 「hermes에 메시지 보내기」가 나갔다.
    expect(CODE_ONLY).not.toContain("에 메시지 보내기");
    expect(CODE_ONLY).not.toContain("에 보낼 메시지");
    // #1422 이후 플레이스홀더는 **재고 나서** 정해지므로 이 파일이 문장을 부르는
    // 자리가 훅으로 바뀌었다. 바뀌지 않은 것은 규칙이다: 이 클라는 그 문장을
    // 짓지 않는다.
    expect(CODE_ONLY).toMatch(
      /useFittedComposerPlaceholder\(\s*inputRef,\s*channelLabel,\s*recipient\s*\)/
    );
    expect(CODE_ONLY).toContain("composerFieldLabel(channelLabel, recipient)");
  });

  it("절도 손으로 짓지 않는다 — 자만 이 클라의 것이다 (#1422)", () => {
    // 이 훅이 하는 일은 「이 상자에 이 글자가 드는가」 하나다. 절의 목록도,
    // 절을 잇는 이음쇠도, 버리는 순서도 코어의 값이라 여기 사본이 있으면
    // 안 된다 — 코어가 문장을 세 절로 늘리는 날 그 사본만 두 절로 남는다.
    const fit = codeOf("./placeholderFit.ts");
    expect(fit).toContain("composerPlaceholderClauses(channelLabel, recipient)");
    expect(fit).toContain("fitComposerPlaceholder(");
    expect(fit).toContain('from "@momo/core/features/chat/composerCopy"');
    // 뒷절의 값도, 이음쇠도 이 파일에 없다.
    expect(fit).not.toContain("@로");
    expect(fit).not.toContain("메시지 보내기");
    expect(fit).not.toContain('join(", ")');
    expect(fit).not.toContain("COMPOSER_PLACEHOLDER_JOINER");
    // 그리고 컴포저 자신도 절을 안 만진다.
    expect(CODE_ONLY).not.toContain("composerPlaceholderClauses");
    expect(CODE_ONLY).not.toContain("fitComposerPlaceholder");
  });

  it("키 힌트의 문장도 이름으로만 든다", () => {
    // 앞 판: "Enter로 보내기, Shift+Enter로 줄바꿈" 이 이 파일에 적혀 있었다.
    expect(CODE_ONLY).not.toContain("Enter로 보내기");
    expect(CODE_ONLY).toContain("COMPOSER_KEYS_HINT");
    // 이음쇠도 값이다: DM 조각과 키 조각을 잇는 " · " 를 손으로 적으면 코어가
    // 이음쇠를 바꾸는 날 이 줄만 옛 표기로 남는다.
    expect(CODE_ONLY).toContain("HINT_SEPARATOR");
  });

  it("수정 입력창도 같은 계약을 쓴다", () => {
    const editor = codeOf("../timeline/MessageEditor.tsx");
    // 앞 판: "Enter 저장 · Shift+Enter 줄바꿈 · Esc 취소" (조사 없는 문법)
    expect(editor).not.toContain("Enter 저장");
    expect(editor).toContain("MESSAGE_EDITOR_KEYS_HINT");
    // 그리고 크기가 같은 한 단이다. 11px(`text-timestamp`)은 묘비의 크기다.
    expect(editor).toContain("wide-only text-meta text-ink-muted");
    expect(editor).not.toContain("text-timestamp");
  });

  it("조사를 정하는 사실은 셸이 넘긴다 — 컴포저가 추측하지 않는다", () => {
    // `recipient` 에 기본값이 없는 것이 이 단정의 전제다: 셸이 안 넘기면
    // 타입이 붉고, 넘기면 그 판정은 `peer` 하나에서 나온다.
    const shell = codeOf("./ChatShell.tsx");
    expect(shell).toContain('recipient={peer ? "person" : "place"}');
  });

  it("스레드 컴포저의 문장도 폰과 한 벌이다", () => {
    const thread = codeOf("../timeline/ThreadComposer.tsx");
    expect(thread).not.toContain('"답글 쓰기"');
    expect(thread).toContain("THREAD_COMPOSER_PLACEHOLDER");
  });

  it("사이드바의 ⌘K 는 이미 그 표기이고, 그대로여야 한다", () => {
    // 여기에 동사가 없는 것은 빠뜨린 것이 아니라 버튼 이름이 동사이기 때문이다.
    // 재는 것은 낱말이 아니라 **옷**이다: 좁은 폭에서 접히고, 12px 흐린 산문이며,
    // 테두리를 두르지 않는다(테두리는 이 시스템에서 컨트롤의 것이다).
    const sidebar = codeOf("../sidebar/Sidebar.tsx");
    expect(sidebar).toContain(
      '<span className="wide-only text-meta text-ink-muted">⌘K</span>'
    );
  });
});
