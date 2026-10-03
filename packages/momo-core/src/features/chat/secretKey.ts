// =============================================================================
// 채팅에 붙여 넣은 API 키를 알아본다 (#2942 GC-1, brief §3.4 「비밀값」).
//
// 키는 카드의 마스킹 입력 칸 → 쓰기 전용 API로만 간다. 메시지에 실리면 채널의
// 모든 사람·검색·알림 미리보기·에이전트 컨텍스트에 남고 지울 수 없다. 그래서
// 컴포저는 키 모양이 보이면 **보내지 않고** 이유를 말한다.
//
// ## 무엇을 키로 보나
//
// 접두 `sk-ant-` · `sk-or-` · `sk-proj-` · `sk-` · `xai-` 뒤에 `[A-Za-z0-9_-]`가
// 20자 이상 이어지고, 그 꼬리 안에 **숫자와 글자가 섞인 16자 이상의 덩어리**가
// 하나라도 있는 토큰이다.
//
// `sk-` 접두만으로는 평문이 걸린다(`sk-learn`, `task-sk-1`, `xai-grok-2-1212`
// 같은 이름·슬러그). 사람이 짓는 이름은 하이픈으로 끊긴 **짧은 낱말**이고, 발급된
// 키는 끊김 없는 **난수 덩어리**다(OpenAI 48자, OpenRouter 64자 hex, xAI 80자,
// Anthropic 95자). 그 차이 하나로 가른다.
//
// ## 앞 경계
//
// 접두 바로 앞이 `[A-Za-z0-9_-]`이면 더 큰 낱말의 일부다(`desk-…`, `task-sk-…`).
// 뒤돌아보기(lookbehind) 정규식을 쓰지 않는 이유: 데스크탑 셸의 WKWebView가
// 지원하지 않는 OS 판이 아직 대상에 있다. 앞 글자는 손으로 본다.
//
// 코드 블록·URL 안이라도 **진짜 키 모양이면 막는다**. 코드 블록에 넣었다고 채널에
// 덜 남는 것이 아니다. 오탐 시험은 키가 아닌 코드·URL이 걸리지 않음을 잰다.
// =============================================================================

const PREFIXED = /(sk-ant-|sk-or-|sk-proj-|sk-|xai-)([A-Za-z0-9_-]{20,})/g;
const WORD_CHAR = /[A-Za-z0-9_-]/;
const RANDOM_RUN = 16;

function hasRandomRun(tail: string): boolean {
  return tail
    .split(/[-_]/)
    .some(
      (segment) =>
        segment.length >= RANDOM_RUN && /[0-9]/.test(segment) && /[A-Za-z]/.test(segment)
    );
}

/** 이 글에 API 키 모양이 있는가. */
export function containsSecretKey(text: string): boolean {
  for (const match of text.matchAll(PREFIXED)) {
    const at = match.index ?? 0;
    if (at > 0 && WORD_CHAR.test(text[at - 1])) continue;
    if (hasRandomRun(match[2])) return true;
  }
  return false;
}

/**
 * 막았을 때 입력창 위에 서는 한 줄(시안 ① 「키 붙여넣기 차단」). 토스트가 아니라
 * 컴포저 자리에서 말한다(ADR-0182).
 */
export const SECRET_KEY_BLOCK_COPY = {
  lead: "키는 채팅에 붙여 넣지 마세요. 이 메시지는 보내지 않았어요.",
  command: "/연결 팀키",
  tail: "로 카드의 입력 칸을 쓰면 저장만 되고 다시 보이지 않아요.",
  /** 카드 자리가 없을 때(GC-3 전·채널 밖): 같은 명령이 설정으로 간다. */
  tailFallback: "로 AI의 입력 칸을 쓰면 저장만 되고 다시 보이지 않아요.",
  /**
   * 스레드 컴포저의 끝 문장. 그 입력창은 `/`를 명령으로 받지 않으므로 명령을
   * 권하지 않고 자리를 말한다(design-review R2 M-2).
   */
  thread: "AI의 입력 칸에 넣으면 저장만 되고 다시 보이지 않아요.",
} as const;
