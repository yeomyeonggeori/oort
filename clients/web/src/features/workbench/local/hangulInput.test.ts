// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { attachHangulInput, isImeProcessedKey, replacementDiff } from "./hangulInput";

/** PTY 줄 편집기 흉내: DEL(0x7f)은 앞 글자 하나를 지운다. */
function lineEdit(stream: string): string {
  const out: string[] = [];
  for (const ch of Array.from(stream)) {
    if (ch === "\u007f") out.pop();
    else out.push(ch);
  }
  return out.join("");
}

/**
 * debug 앱에서 기록한 사건 모양 그대로(2벌식 「gksrmf」 → 「한글」):
 * insertText로 첫 자모, 이어서 insertReplacementText로 조합 중인 음절 전체가
 * 입력 칸 값을 바꾼다. 조합 사건은 없다.
 */
function typeRecorded(textarea: HTMLTextAreaElement, steps: [string, string][]) {
  for (const [inputType, data] of steps) {
    textarea.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType, data }));
    if (inputType === "insertText") textarea.value += data;
    else textarea.value = textarea.value.slice(0, -1) + data;
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: data, keyCode: 229 }));
  }
}

function setup() {
  const host = document.createElement("div");
  const textarea = document.createElement("textarea");
  host.append(textarea);
  document.body.append(host);
  const sent: string[] = [];
  const xtermSaw: string[] = [];
  // xterm의 처리기 자리: 입력 칸 자체의 input 처리기.
  textarea.addEventListener("input", (e) => xtermSaw.push((e as InputEvent).inputType));
  const detach = attachHangulInput(host, textarea, (d) => sent.push(d));
  return { textarea, sent, xtermSaw, detach };
}

describe("한글 입력 다리 (WKWebView insertReplacementText)", () => {
  it("「한글」이 PTY에서 「한글」로 끝난다(모음을 잃지 않는다)", () => {
    const { textarea, sent, xtermSaw } = setup();
    typeRecorded(textarea, [
      ["insertText", "ㅎ"],
      ["insertReplacementText", "하"],
      ["insertReplacementText", "한"],
      ["insertText", "ㄱ"],
      ["insertReplacementText", "그"],
      ["insertReplacementText", "글"],
    ]);
    expect(lineEdit(sent.join(""))).toBe("한글");
    // xterm의 input 처리기는 이 사건들을 보지 않는다(두 번 보내지 않는다).
    expect(xtermSaw).toEqual([]);
  });

  it("받침이 다음 음절로 넘어가도(한 + ㅏ → 하나) 맞게 고친다", () => {
    const { textarea, sent } = setup();
    textarea.value = "";
    textarea.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "한" }));
    textarea.value = "한";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "한" }));
    textarea.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertReplacementText", data: "하나" }));
    textarea.value = "하나";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: "하나" }));
    expect(lineEdit(sent.join(""))).toBe("하나");
  });

  it("조합 사건 모양(insertCompositionText)은 xterm에 그대로 둔다", () => {
    const { textarea, sent, xtermSaw } = setup();
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "하" }));
    expect(sent).toEqual([]);
    expect(xtermSaw).toEqual(["insertCompositionText"]);
  });

  it("떼면 더 받지 않는다", () => {
    const { textarea, sent, detach } = setup();
    detach();
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "ㅎ" }));
    expect(sent).toEqual([]);
  });

  it("차이는 코드 포인트로 센다", () => {
    expect(replacementDiff("한ㄱ", "한그")).toEqual({ erase: 1, insert: "그" });
    expect(replacementDiff("ㅎ", "하")).toEqual({ erase: 1, insert: "하" });
    expect(replacementDiff("", "ㅎ")).toEqual({ erase: 0, insert: "ㅎ" });
  });

  it("입력기가 처리한 키(229)만 xterm에서 거른다", () => {
    expect(isImeProcessedKey({ keyCode: 229 })).toBe(true);
    expect(isImeProcessedKey({ keyCode: 65 })).toBe(false);
  });
});
