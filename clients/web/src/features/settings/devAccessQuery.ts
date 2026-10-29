import type { QueryClient, UseMutationOptions } from "@tanstack/react-query";
import {
  createDevCredential,
  getDevAccessPolicy,
  listDevCredentials,
  type CreateDevCredentialInput,
  type CreatedDevCredential,
  type DevAccessPolicy,
  type DevCredential,
} from "@momo/core/features/auth/devAccess";

// =============================================================================
// 설정 › 명령줄·AI 도구의 서버 읽기와, 한 번만 보이는 비밀의 수명 (#4663, ADR-0216).
//
// ## 읽기
// 쿼리 옵션은 **모듈 스코프에서만** 만든다(`linkedDevicesQuery`·`webhookCredentialScope`와 같은
// 규율). 컴포넌트 안에서 `queryFn: async () => …`를 쓰면 그 클로저가 렌더 스코프를 통째로 캡처하고,
// 그 쿼리는 관찰자가 0이 된 뒤에도 자기 gcTime 동안 산다. 렌더 스코프에는 방금 만든 연결 값이 있다.
// 키는 전부 `["settings", …]` 접두라 `resetSettingsQueries`가 덮는다. 쿼리 캐시에는 연결 값도
// 비밀번호도 들어가지 않는다(목록 응답에는 비밀이 없다).
//
// ## 비밀
// 연결 값(`CreatedDevCredential.token`)의 유일한 보관처는 만들기 뮤테이션의 결과(`data`)다.
// `setQueryData`·저장소·주소·로그에 넣지 않는다. 「저장했어요」가 뮤테이션을 `reset()`하는 것이
// 지우는 행위이고, `gcTime: 0`과 전용 키가 화면이 사라진 뒤에도 캐시가 붙잡지 못하게 한다.
//
// 비밀번호는 입력 칸의 상태에서 **상자**(`PasswordBox`)로 옮겨 가고, 요청을 보내는 순간 상자가
// 비워진다. 뮤테이션 변수에 평문이 남지 않는다: 변수는 연결 값이 화면에 떠 있는 동안 캐시에
// 살아 있고, 그 사이 같은 자리에 로그인 비밀번호가 함께 앉아 있을 이유가 없다. 그 요청 함수도
// 이 모듈에서 만든다(`createDevCredentialFn`): 렌더 안에서 만든 클로저는 그 렌더가 본 상태
// (방금 친 비밀번호)를 함께 붙잡는다.
// =============================================================================

/** 설정 쿼리 접두. `resetSettingsQueries`가 이 아래를 모두 되돌린다. */
export const DEV_ACCESS_QUERY_KEY = ["settings", "dev-access"] as const;

/** 목록의 두 보기. `all`은 소유자·관리자만 서버가 열어 준다(`?scope=all`). */
export type DevListScope = "mine" | "all";

export function devAccessPolicyQueryKey(workspaceId: string) {
  return [...DEV_ACCESS_QUERY_KEY, "policy", workspaceId] as const;
}

/** 두 보기(`mine`·`all`)를 함께 덮는 접두. 만들기·지우기 뒤 목록을 다시 읽을 때 쓴다. */
export function devCredentialsQueryPrefix(workspaceId: string) {
  return [...DEV_ACCESS_QUERY_KEY, "credentials", workspaceId] as const;
}

export function devCredentialsQueryKey(workspaceId: string, scope: DevListScope) {
  return [...devCredentialsQueryPrefix(workspaceId), scope] as const;
}

/**
 * 스위치와 내 권한. `canCreate`·`canManageAll`이 이 화면의 문을 정한다. 연결 만들기의 문이므로
 * 열 때마다 새로 읽는다(`staleTime: 0`): 관리자가 스위치를 바꾼 지 30초 안에 연 사람이 낡은
 * 답으로 폼을 보면 만들기 직전에 거절당한다.
 */
export function devAccessPolicyQuery(workspaceId: string) {
  return {
    queryKey: devAccessPolicyQueryKey(workspaceId),
    queryFn: async (): Promise<DevAccessPolicy> => getDevAccessPolicy(workspaceId),
    staleTime: 0,
    // 403·404는 「누가 할 수 있는가」「이 서버가 아직 모른다」를 그리는 분기이지 일시 오류가 아니다.
    retry: false,
  };
}

/**
 * 살아 있는 연결 목록. 보안 표면(지금 누가 내 계정으로 들어올 수 있는가)이라 열 때마다 새로 읽는다.
 */
export function devCredentialsQuery(workspaceId: string, scope: DevListScope) {
  return {
    queryKey: devCredentialsQueryKey(workspaceId, scope),
    queryFn: async (): Promise<DevCredential[]> =>
      listDevCredentials(workspaceId, { all: scope === "all" }),
    staleTime: 0,
    retry: false,
  };
}

// ---- 만들기: 비밀의 수명 ------------------------------------------------------------

/**
 * 이 키를 단 뮤테이션은 일회성 비밀의 수명 규율 아래 있다. 연결 값이 응답에 실리는 만들기 하나다.
 * 지우기는 단 곳이 다른 컴포넌트(목록)이고 그 렌더 스코프에는 연결 값이 없어서 이 키를 달지 않는다
 * (웹훅 화면은 한 컴포넌트가 발급과 폐기를 함께 들어서 셋 다 달았다. 여기는 그렇지 않다).
 */
export const DEV_CREDENTIAL_MUTATION_KEY = [...DEV_ACCESS_QUERY_KEY, "credential"] as const;

/** 이 표면의 뮤테이션이 지켜야 하는 옵션. 펼쳐 넣는다. */
export const DEV_CREDENTIAL_MUTATION_SCOPE = {
  mutationKey: DEV_CREDENTIAL_MUTATION_KEY,
  // 브라우저 기본값은 300000. 일회성 비밀의 올바른 수명은 「그것을 보여 주던 화면과 같다」이다.
  gcTime: 0,
} satisfies Pick<UseMutationOptions, "mutationKey" | "gcTime">;

/**
 * 캐시에 남은 이 표면의 뮤테이션을 전부 지운다(본문과, 그 본문이 사는 스코프를 붙잡은 클로저까지).
 * 전역이 아니라 위 키로 좁힌다: 설정 셸에는 남의 진행 상태도 살아 있다. 멱등이다.
 *
 * @returns 지운 수. 시험이 「정말 있었고 정말 사라졌다」를 잴 수 있게.
 */
export function purgeDevCredentials(client: QueryClient): number {
  const cache = client.getMutationCache();
  const held = cache.findAll({ mutationKey: DEV_CREDENTIAL_MUTATION_KEY, exact: true });
  for (const mutation of held) cache.remove(mutation);
  return held.length;
}

/** 비밀번호를 한 번 건네는 상자. 요청이 읽는 즉시 비워진다. */
export interface PasswordBox {
  value: string;
}

/** 만들기 뮤테이션의 변수. 비밀번호는 상자에 담겨 가므로 변수에 평문이 남지 않는다. */
export interface CreateDevCredentialVariables {
  input: Omit<CreateDevCredentialInput, "currentPassword">;
  password: PasswordBox;
}

/**
 * 만들기 요청 함수. **모듈 스코프에서 만든다**: 돌려주는 함수가 붙잡는 것은 `workspaceId` 하나다.
 * 비밀번호는 요청 본문을 짓는 순간에만 문자열로 존재하고, 상자는 그 전에 비워진다.
 */
export function createDevCredentialFn(workspaceId: string) {
  return async ({
    input,
    password,
  }: CreateDevCredentialVariables): Promise<CreatedDevCredential> => {
    const currentPassword = password.value;
    password.value = "";
    return createDevCredential(workspaceId, { ...input, currentPassword });
  };
}
