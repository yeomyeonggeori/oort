import type { QueryClient, UseMutationOptions } from "@tanstack/react-query";
import { listWebhookInstallations } from "@momo/core/features/webhooks/api";
import { parseInstallations } from "@momo/core/features/webhooks/model";

// =============================================================================
// 일회성 웹훅 비밀값을 붙잡을 수 있는 것들을, 그 값을 보여준 화면의 수명에 묶는다.
//
// ## 잰 것 (#1205 리뷰 R2, 힙 스냅샷)
//
// 1차 수리는 **MutationCache** 를 닫았다. 그것은 실제로 닫혔다(R2 실측: abandon
// 경로에서 mutation 0, 캐시에 비밀값 없음). 그런데 원문은 여전히 화면보다 오래
// 살았다. 강제 GC 뒤 힙에서 나온 리테이너 경로가 이것이다:
//
//   Window → DOMTimer → [closure] → 목록 Query
//     → options.queryFn ← **컴포넌트 안에서 만든 인라인 클로저**
//       → 그 클로저의 컨텍스트(= 렌더 스코프)
//         → revealed.credential.secret
//
// 즉 캐시가 **본문**을 들고 있어서가 아니라, 세션 수명 캐시에 얹힌 클로저가
// 비밀값이 사는 **스코프**를 들고 있어서였다. 목록 Query 는 관찰자가 0이 된 뒤
// 자기 gcTime(300000ms) 타이머에 붙잡히고, 그 타이머가 그 스코프를 함께 붙잡는다.
// 숫자는 5분 그대로였고 문의 이름만 바뀌었다.
//
// V8 은 한 함수 호출의 컨텍스트를 **하나** 만든다. 렌더 스코프의 클로저 중 하나만
// 살아남아도 그 렌더가 본 것 전부가 함께 산다 — `revealed` 를 참조하지 않는
// 클로저여도 마찬가지다. 그래서 규율은 "비밀값을 넘기지 마라"가 아니라 이것이다:
//
//   **세션 수명 캐시에는 이 표면의 렌더 스코프에서 태어난 클로저를 얹지 않는다.**
//
// ## 그래서 이 파일에 두 가지가 있다
//
// 1. `webhookListQuery` — 목록 쿼리의 옵션을 **모듈 스코프**에서 만든다. 돌려주는
//    `queryFn` 이 붙잡는 것은 이 팩토리의 인자(`workspaceId`) 하나뿐이라, 그 쿼리가
//    5분을 살아도 함께 사는 것은 문자열 하나다. 컴포넌트는 쿼리 함수를 짓지 않는다.
//
// 2. `CREDENTIAL_MUTATION_SCOPE` + `purgeWebhookCredentials` — mutation 은 사정이
//    다르다. `mutationFn` 과 콜백은 상태 세터를 부르므로 렌더 스코프를 떠날 수
//    없다. 그쪽은 캡처를 없애는 대신 **수명을 화면에 묶는다**: `gcTime: 0` 으로
//    마지막 관찰자가 떨어지는 즉시 회수 대상이 되게 하고, 전용 키로 언마운트에서
//    동기 purge 한다(gcTime 0 은 다음 매크로태스크를 기다리므로 틱 하나의 창이
//    남는다). 그래서 이 표면의 mutation 은 **셋 다** 이 스코프를 단다 — 폐기는
//    비밀값을 실어 나르지 않지만, 그 콜백이 비밀값이 사는 같은 렌더 스코프를
//    붙잡는다. 캐시에 남는 것은 본문이 아니라 스코프다.
//
// ## 이 스위트가 볼 수 있는 것과 없는 것
//
// 아래 테스트는 진짜 QueryClient 를 세우지만 도는 곳은 DOM 없는 node 이고, 재는
// 것은 캐시의 **모양**이다(무엇이 지워지는가, 무엇이 남는가, 키가 하나인가).
// 힙에서의 도달 가능성은 여기서 잴 수 없다 — 1차 수리가 그 자리에서 초록이었고
// 힙에서 빨강이었던 것이 정확히 이 한계다. 힙은 실제 앱을 세워 강제 GC 뒤
// 스냅샷을 읽는 게이트가 잰다:
//
//   npm run build && npm run gate:webhook       (clients/web/gates/gate-webhook-credential.mjs)
// =============================================================================

/** 목록 쿼리의 키. 무효화하는 쪽과 읽는 쪽이 같은 곳에서 든다. */
export function webhookListQueryKey(workspaceId: string) {
  return ["settings", "webhooks", workspaceId] as const;
}

/**
 * 목록 쿼리 옵션. **모듈 스코프에서만 만든다.**
 *
 * 컴포넌트 안에서 `queryFn: async () => …` 를 쓰면 그 클로저가 렌더 스코프를
 * 통째로 캡처하고, 그 쿼리는 관찰자가 0이 된 뒤에도 자기 gcTime 동안 산다.
 * 그것이 R2 가 힙에서 찾아낸 경로다(머리말). 여기서 만들면 `queryFn` 이 붙잡는
 * 것은 `workspaceId` 뿐이다.
 */
export function webhookListQuery(workspaceId: string) {
  return {
    queryKey: webhookListQueryKey(workspaceId),
    queryFn: async () =>
      parseInstallations(await listWebhookInstallations(workspaceId)),
    // 목록 403 은 "누가 할 수 있는가"를 그리는 분기이지 일시 오류가 아니다.
    retry: false,
  };
}

/**
 * 이 키를 단 mutation 은 일회성 비밀값의 수명 규율 아래 있다고 선언한다.
 *
 * 발급·회전은 응답 본문에 원문을 담고(openapi `createWebhookInstallation` /
 * `rotateWebhookSecret`), 폐기는 담지 않지만 그 콜백이 원문이 사는 렌더 스코프를
 * 붙잡는다. 캐시가 붙잡는 것이 본문만이 아니므로 셋 다 이 키를 단다.
 */
export const WEBHOOK_CREDENTIAL_MUTATION_KEY = [
  "settings",
  "webhooks",
  "credential",
] as const;

/** 이 표면의 mutation 이 지켜야 하는 옵션. 펼쳐 넣는다. */
export const CREDENTIAL_MUTATION_SCOPE = {
  mutationKey: WEBHOOK_CREDENTIAL_MUTATION_KEY,
  // 기본값은 브라우저에서 300000, 서버 환경에서는 Infinity 다. 둘 다 이 값에는
  // 너무 길다: 일회성 비밀값의 올바른 수명은 "그것을 보여주던 화면과 같다"이다.
  gcTime: 0,
} satisfies Pick<UseMutationOptions, "mutationKey" | "gcTime">;

/**
 * 캐시에 남은 이 표면의 mutation 을 전부 지운다 — 본문과, 그 본문이 사는 스코프를
 * 붙잡고 있는 클로저까지.
 *
 * 전역이 아니라 위 키로 좁힌다: 설정 셸에는 다른 표면의 mutation 도 살아 있고,
 * 비밀값 하나를 지우자고 남의 진행 상태를 날리는 것은 다른 종류의 결함이다.
 * 전체 함수이고 멱등이다 — 지울 것이 없으면 0을 돌려준다.
 *
 * @returns 지운 mutation 수. 테스트가 "정말 있었고 정말 사라졌다"를 잴 수 있게.
 */
export function purgeWebhookCredentials(client: QueryClient): number {
  const cache = client.getMutationCache();
  const held = cache.findAll({
    mutationKey: WEBHOOK_CREDENTIAL_MUTATION_KEY,
    exact: true,
  });
  for (const mutation of held) cache.remove(mutation);
  return held.length;
}
