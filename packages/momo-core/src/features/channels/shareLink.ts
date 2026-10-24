// =============================================================================
// 채널 링크 — 폰이 「링크 복사하기」로 내놓는 주소 (#4229).
//
// 웹은 `channelShareUrl(channelId, {origin, pathname})` 로 **브라우저가 지금 서 있는 주소**에 해시 경로를 붙인다
// (`clients/web/src/features/inbox/anchor.ts`). 폰에는 브라우저 주소가 없고 서버 주소(`apiBase`)만 있다. 서버가 웹 클라이언트를
// 같은 출처의 `/` 에서 내놓으므로(셀프호스트·Railway 모두) 웹 주소 = 서버 주소 + `/` 다.
//
// 모양은 웹과 한 글자도 달라서는 안 된다 — 붙여넣은 사람이 웹에서 열어 그 채널로 착지해야 한다. 웹 쪽 시험
// (`anchor.test.ts` 「폰 채널 링크」)이 두 함수의 결과를 직접 견준다.
// =============================================================================

/** 채널로 착지하는 해시 경로. 웹 `channelPath` 와 같은 모양이다(자리 `?seq=` 는 채널 링크에 없다). */
export function channelHashPath(channelId: string): string {
  return `/c/${encodeURIComponent(channelId)}`;
}

/** 서버 주소(끝 `/` 는 무시)에서 만든 채널 링크. `serverBase` 가 비면 `null` — 지어내지 않는다. */
export function channelShareUrlFromServerBase(
  serverBase: string,
  channelId: string
): string | null {
  const base = serverBase.trim().replace(/\/+$/, "");
  if (base === "") return null;
  return `${base}/#${channelHashPath(channelId)}`;
}
