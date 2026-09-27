// @vitest-environment jsdom

import {
  act,
  createElement,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import {
  composerKeyIntent,
  isComposingEvent,
} from "@momo/core/features/chat/composerKeys";
import { resetEscapeLayers } from "@/design/ui/escapeLayer";
import { ComposerAutocompleteList } from "./ComposerAutocompleteList";
import {
  commandCandidates,
  composerTriggerQueryAt,
  mentionQueryAt,
  type ComposerCandidate,
} from "./composerAutocomplete";
import { useComposerAutocomplete } from "./useComposerAutocomplete";

// =============================================================================
// 컴포저 `/` 트리거 (#2942 GC-1).
//
//   ① 메시지 **맨 앞**에서만 연다. 문장 중간의 `/`는 본문이다.
//   ② 맨 앞 질의는 공백 하나까지 허락한다(`/연결 claude`). 둘부터는 문장이다.
//   ③ `@`·`#`·`:`의 판정은 한 글자도 바뀌지 않는다.
//   ④ 명령 줄은 삽입하지 않고 실행한다. 알 수 없는 `/`는 목록이 없고 ↵는 평문.
//   ⑤ `/`를 받지 않는 컴포저(스레드)에서는 목록이 서지 않는다.
// =============================================================================

const q = (value: string) => composerTriggerQueryAt(value, value.length);

describe("① 맨 앞에서만", () => {
  it("인덱스 0의 `/`가 명령 질의를 연다", () => {
    expect(q("/")).toEqual({ kind: "command", start: 0, text: "" });
    expect(q("/연")).toEqual({ kind: "command", start: 0, text: "연" });
    expect(q("/connect")).toEqual({ kind: "command", start: 0, text: "connect" });
  });

  it("문장 중간·공백 뒤·낱말 안의 `/`는 열지 않는다", () => {
    expect(q("hello /ai")).toBeNull();
    expect(q("and/or")).toBeNull();
    expect(q("2026/09/27")).toBeNull();
    expect(q(" /연결")).toBeNull();
    expect(q("첫 줄\n/연결")).toBeNull();
  });
});

describe("② 공백은 하나까지", () => {
  it("이름 뒤 인자 자리가 열린다", () => {
    expect(q("/연결 ")).toEqual({ kind: "command", start: 0, text: "연결 " });
    expect(q("/연결 cl")).toEqual({ kind: "command", start: 0, text: "연결 cl" });
  });

  it("공백 둘부터·줄바꿈은 문장이다", () => {
    expect(q("/연결 해 주세요")).toBeNull();
    expect(q("/tmp/foo 경로 봐줘")).toBeNull();
    expect(q("/연결\n")).toBeNull();
  });
});

describe("③ 다른 세 트리거는 그대로", () => {
  it("명령 뒤에 친 멘션은 멘션으로 열린다", () => {
    expect(q("/연결 @her")).toEqual({ kind: "mention", start: 4, text: "her" });
  });

  it("#1930 이전 멘션 판정이 같다", () => {
    expect(mentionQueryAt("@her", 4)).toEqual({ start: 0, text: "her" });
    expect(mentionQueryAt("a@her", 5)).toBeNull();
    expect(mentionQueryAt("/@her", 5)).toBeNull();
    expect(q("#gen")).toEqual({ kind: "channel", start: 0, text: "gen" });
    expect(q("좋아요 :thu")).toEqual({ kind: "emoji", start: 4, text: "thu" });
  });
});

describe("④ 후보는 레지스트리에서", () => {
  it("줄은 client 명령과 그 인자이고, 삽입 글자가 없다", () => {
    const rows = commandCandidates("연");
    expect(rows.map((row) => row.lead)).toEqual([
      "/연결",
      "/연결 claude",
      "/연결 codex",
      "/연결 팀키",
    ]);
    for (const row of rows) {
      expect(row.kind).toBe("command");
      expect(row.insert).toBe("");
      expect(row.command?.commandId).toBe("ai.connect");
    }
    expect(rows[3].command?.args).toEqual({ line: "team" });
  });

  it("알 수 없는 `/`는 후보가 없다", () => {
    expect(commandCandidates("shrug")).toEqual([]);
    expect(commandCandidates("tmp/foo")).toEqual([]);
  });
});

// ---- 하네스: 채널 컴포저의 `form > (목록, textarea)` 자리 -----------------------

const MEMBERS: RosterMember[] = [];
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let ran: ComposerCandidate[] = [];
let sent: string[] = [];

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  ran = [];
  sent = [];
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  host?.remove();
  host = null;
  resetEscapeLayers();
});

function Probe({ commands }: { commands: boolean }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const auto = useComposerAutocomplete({
    value,
    members: MEMBERS,
    channels: [],
    inputRef,
    onValueChange: setValue,
    ...(commands
      ? {
          onRunCommand: (candidate: ComposerCandidate) => {
            // 진짜 컴포저의 `runCommand`: 본문을 비우고 실행한다(전송 없음).
            ran.push(candidate);
            setValue("");
          },
        }
      : {}),
  });
  return createElement(
    "form",
    { onSubmit: (event: { preventDefault: () => void }) => event.preventDefault() },
    createElement(ComposerAutocompleteList, {
      id: "probe-list",
      kind: auto.kind,
      candidates: auto.candidates,
      highlight: auto.highlight,
      onChoose: auto.choose,
      testId: "probe-list",
      optionTestId: "probe-option",
    }),
    createElement("textarea", {
      ref: inputRef,
      value,
      "data-testid": "probe-input",
      onChange: (event: { target: HTMLTextAreaElement }) =>
        auto.onTextChange(event.target.value, event.target.selectionStart ?? 0),
      onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => {
        const intent = composerKeyIntent(
          {
            key: event.key,
            shiftKey: event.shiftKey,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            composing: isComposingEvent(event.nativeEvent),
          },
          { mentionsOpen: auto.visible, justComposed: false, enterSends: true }
        );
        if (auto.handleIntent(intent)) {
          event.preventDefault();
          return;
        }
        if (intent === "send") {
          sent.push(value);
          event.preventDefault();
        }
      },
    })
  );
}

function mount(node: ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  act(() => mountedRoot?.render(node));
}

const VALUE_SETTER = Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype,
  "value"
)?.set;

function input(): HTMLTextAreaElement {
  return document.querySelector<HTMLTextAreaElement>("[data-testid='probe-input']")!;
}

function typeAll(text: string) {
  const node = input();
  node.focus();
  for (const char of text) {
    const next = node.value + char;
    act(() => {
      VALUE_SETTER?.call(node, next);
      node.setSelectionRange(next.length, next.length);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
}

function press(key: string) {
  act(() => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

const options = () => [
  ...document.querySelectorAll<HTMLElement>("[data-testid='probe-option']"),
];

describe("④ 명령 줄은 실행이다", () => {
  it("`/연` + ↵ 는 첫 줄을 실행하고 전송하지 않는다", () => {
    mount(createElement(Probe, { commands: true }));
    typeAll("/연");
    expect(options().map((node) => node.textContent)).toEqual([
      expect.stringContaining("/연결"),
      expect.stringContaining("/연결 claude"),
      expect.stringContaining("/연결 codex"),
      expect.stringContaining("/연결 팀키"),
    ]);
    // 머리글·발치는 listbox 밖이다(옵션으로 세지 않는다).
    const listbox = document.querySelector("[data-testid='probe-list']")!;
    expect(listbox.getAttribute("role")).toBe("listbox");
    expect(listbox.getAttribute("aria-label")).toBe("명령");
    expect(document.querySelector("[data-testid='probe-list-foot']")?.textContent).toContain(
      "메시지 맨 앞에서만 열려요"
    );
    press("ArrowDown");
    press("Enter");
    expect(ran.map((row) => row.command?.args)).toEqual([{ line: "claude" }]);
    expect(sent).toEqual([]);
    expect(input().value).toBe("");
  });

  it("알 수 없는 `/`는 목록이 없고 ↵는 평문 전송이다", () => {
    mount(createElement(Probe, { commands: true }));
    typeAll("/shrug");
    expect(options()).toEqual([]);
    press("Enter");
    expect(ran).toEqual([]);
    expect(sent).toEqual(["/shrug"]);
  });

  it("문장 중간의 `/연결`은 목록을 열지 않는다", () => {
    mount(createElement(Probe, { commands: true }));
    typeAll("그럼 /연결");
    expect(options()).toEqual([]);
  });
});

describe("⑤ `/`를 받지 않는 컴포저", () => {
  it("스레드처럼 실행자가 없으면 목록이 서지 않고 ↵는 평문이다", () => {
    mount(createElement(Probe, { commands: false }));
    typeAll("/연결");
    expect(options()).toEqual([]);
    press("Enter");
    expect(sent).toEqual(["/연결"]);
  });
});
