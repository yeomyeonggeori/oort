// =============================================================================
// 한글 입력 다리 (#2774). WKWebView(Tauri 데스크탑)에서 xterm.js로 한글을
// 치면 모음이 사라지고 자모만 남는다(「한글」 → 「ㅎㄱ」). 실측(debug 앱,
// 2벌식, 입력 칸 textarea의 사건 기록):
//
//   beforeinput insertText "ㅎ"               v=""
//   input       insertText "ㅎ"               v="ㅎ"   → xterm이 "ㅎ"를 보낸다
//   keydown     ㅎ 229 isComposing=false
//   beforeinput insertReplacementText "하"    v="ㅎ"
//   input       insertReplacementText "하"    v="하"   → xterm은 이 종류를 무시한다
//   keydown     ㅏ 229 isComposing=false
//
// 조합 사건(composition*)이 오지 않고, 조합 중인 글자는 「바꿔 넣기」로 온다.
// xterm은 `insertText`만 처리하므로 바뀐 글자가 PTY에 가지 않는다. 같은 증상이
// xterm.js 이슈와 다른 Tauri 터미널에 보고돼 있다(PR 본문 출처).
//
// 다리: 입력 칸의 input 사건을 xterm보다 먼저(캡처) 받는다.
// - `insertText`: 그 글자를 보낸다.
// - `insertReplacementText`: 바뀌기 전 값과 뒤 값을 비교해, 사라진 글자 수만큼
//   DEL(0x7f)을 보내고 새 글자를 보낸다. 셸 줄 편집기와 TUI는 DEL로 앞 글자를
//   지운다. 「ㅎ → 하 → 한」은 PTY에 「ㅎ DEL 하 DEL 한」으로 간다.
// 두 경우 모두 사건을 입력 칸에 닿기 전에 끊어 xterm의 input 처리기가 보지
// 않게 한다(두 번 보내지 않는다).
// 조합 사건이 오는 모양(`insertCompositionText`)은 xterm의 조합 도우미가 맡으므로
// 건드리지 않는다.
//
// 키 사건 쪽: keyCode 229(입력기가 처리한 키)는 xterm에 주지 않는다
// (`isImeProcessedKey`). xterm은 그 키에서 입력 칸 값의 전후를 비교해 다시 보내는
// 길(_handleAnyTextareaChanges)이 있어, 사건 순서가 바뀌면 같은 글자를 한 번 더
// 보낸다.
// =============================================================================

const DEL = "\u007f";

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"]);

/** 바뀌기 전 값과 뒤 값에서 지울 글자 수와 넣을 글자. 글자는 코드 포인트로 센다. */
export function replacementDiff(before: string, after: string): { erase: number; insert: string } {
  const a = Array.from(before.normalize("NFC"));
  const b = Array.from(after.normalize("NFC"));
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return { erase: a.length - prefix, insert: b.slice(prefix).join("") };
}

/** 한 번의 바꿔 넣기가 PTY에 보낼 바이트(문자열). */
export function replacementPayload(before: string, after: string): string {
  const { erase, insert } = replacementDiff(before, after);
  return DEL.repeat(erase) + insert;
}

/** xterm의 사용자 키 처리기에서 거를 키: 입력기가 처리한 키(229). */
export function isImeProcessedKey(event: { keyCode?: number; type?: string }): boolean {
  return event.keyCode === 229;
}

/**
 * xterm의 입력 칸에 다리를 놓는다. `send`는 칸의 입력 경로(세션 input)다.
 * 듣는 곳은 입력 칸의 조상(`host`)의 캡처 단계다: 대상 단계에서는 캡처와
 * 버블 처리기의 순서가 엔진마다 달라, xterm보다 먼저라는 보장이 없다.
 * 되돌리는 함수는 떼기다.
 */
export function attachHangulInput(
  host: HTMLElement,
  textarea: HTMLTextAreaElement,
  send: (data: string) => void
): () => void {
  let before: string | null = null;
  /**
   * 마지막 input 뒤에 xterm이 스스로 처리하는 키(229가 아닌 keydown)가 있었나.
   * 그렇다면 뒤따르는 insertText는 xterm이 이미 보낸 글자다(빈칸이 대표적이다:
   * keydown 32에서 xterm이 보내고, WKWebView와 Chromium은 insertText " "를 또
   * 쏜다). 입력기 글자는 keydown 229이거나, WKWebView처럼 keydown보다 먼저 온다.
   */
  let xtermHandledKey = false;

  const onKeyDown = (event: Event) => {
    if (event.target !== textarea) return;
    const e = event as KeyboardEvent;
    // 수식 키만 눌린 keydown은 글자를 만들지 않는다. 쌍자음(⇧+ㄱ)의 ⇧가 다음
    // 입력기 글자를 「xterm이 보낸 것」으로 오인하게 하면 안 된다.
    if (MODIFIER_KEYS.has(e.key)) return;
    xtermHandledKey = !isImeProcessedKey(e) && !e.isComposing;
  };

  const onBeforeInput = (event: Event) => {
    if (event.target !== textarea) return;
    const e = event as InputEvent;
    if (e.inputType === "insertReplacementText" || e.inputType === "insertText") {
      before = textarea.value;
    }
  };

  const onInput = (event: Event) => {
    if (event.target !== textarea) return;
    const e = event as InputEvent;
    if (e.inputType === "insertText") {
      before = null;
      const handled = xtermHandledKey;
      xtermHandledKey = false;
      // xterm이 키에서 이미 보냈다. xterm의 input 처리기도 같은 판단으로 버린다.
      if (handled) return;
      if (typeof e.data === "string" && e.data !== "") send(e.data);
      event.stopPropagation();
      return;
    }
    if (e.inputType === "insertReplacementText") {
      xtermHandledKey = false;
      const prior = before ?? "";
      before = null;
      const payload = replacementPayload(prior, textarea.value);
      if (payload !== "") send(payload);
      event.stopPropagation();
    }
  };

  host.addEventListener("keydown", onKeyDown, true);
  host.addEventListener("beforeinput", onBeforeInput, true);
  host.addEventListener("input", onInput, true);
  return () => {
    host.removeEventListener("keydown", onKeyDown, true);
    host.removeEventListener("beforeinput", onBeforeInput, true);
    host.removeEventListener("input", onInput, true);
  };
}
