// =============================================================================
// 에이전트 격리 안에서는 브라우저를 띄우지 않는다(#4861). Codex 워커의 명령은 seatbelt 격리 안에서
// 돌고, 격리가 창 서버 연결을 막아 WebKit(`Playwright.app`)은 시작하자마자 abort한다 — 그때마다
// macOS가 「예기치 않게 종료」 창을 띄운다. Chromium도 같은 자리에서 시작하지 못한다. 엔진 판별은
// 실행 파일이 있는지만 보므로 격리 안에서도 통과하고, 띄우다 죽었다.
//
// Codex는 격리 안 명령에 `CODEX_SANDBOX`(macOS는 `seatbelt`)를 넣는다. 이 값이 있으면 엔진 판별이
// 이유를 돌려주고, 브라우저 시험은 엔진이 없는 CI 레인과 같은 길(경고 + `skipIf`)로 건너뛴다.
// 실제 엔진 실측은 격리 밖에서 돈다.
// =============================================================================

/** 격리 안이면 브라우저를 띄우지 않을 이유를, 격리 밖이면 `null`을 돌려준다. */
export function browserLaunchBlocked(): string | null {
  const sandbox = process.env.CODEX_SANDBOX;
  return sandbox ? `agent sandbox (CODEX_SANDBOX=${sandbox}) cannot start browsers; run outside it` : null;
}
