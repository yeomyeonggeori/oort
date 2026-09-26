// =============================================================================
// 홈 머리의 로고 자리와 큰 제목 — 순수 판정 (DS2-3 #2715).
//
// 규칙은 웹 워크스페이스 레일의 것이다(`clients/web/src/features/sidebar/
// workspaceRailModel.ts`, 검수 피드백 #4a-1 · ADR-0161 D5):
//
//   - 그리는 것은 **워크스페이스**다. 사람의 이름은 입력에 들어올 자리조차 없다 —
//     웹의 결함이 로그인한 사람의 이름을 레일 타일에 꽂은 것이었다. 그래서 이 함수도
//     이름 문자열이 아니라 조회 결과를 받는다.
//   - 아바타가 있으면 그 그림이다(서버가 준 content 경로, 인가 프록시).
//   - 이름이 오기 전에는 **아무것도 그리지 않는다.** 근처 문자열로 세운 글자가 그
//     결함의 시작이었다.
//
// 웹과 다른 한 가지: 아바타가 없을 때 웹 레일은 이름 첫 글자를 세우고, 이 자리는
// **브랜드 배지(코메토)** 를 세운다. 시안 A 의 이 자리는 「로고 자리」이고, 워커
// 지시는 「로고 자리에는 머지된 브랜드 자산을 쓴다」다(DS2 공통 규약). 큰 제목이
// 바로 옆에서 워크스페이스 이름을 이미 말하므로 첫 글자는 같은 사실의 반복이다.
//
// 규칙 한 벌이 두 클라이언트에 있는 것은 이 배치의 부채다 — 웹 파일은 다른 워커의
// 범위(#2718)라 이 PR 이 옮기지 않는다. 코어로 올리는 후속을 PR 에 적는다.
// =============================================================================

/** 워크스페이스 조회에서 이 자리가 읽는 조각. `WorkspaceNameState`의 폰 짝. */
export interface WorkspaceIdentityState {
  name?: string;
  avatarUrl?: string;
  isPending: boolean;
  isError: boolean;
}

export type WorkspaceLogo =
  /** 서버가 준 워크스페이스 아바타 경로(검증됨). */
  | {kind: 'avatar'; path: string}
  /** 브랜드 배지. 아바타가 없거나 이름을 못 받았을 때. */
  | {kind: 'brand'}
  /** 아직 모른다 — 빈 원. */
  | {kind: 'pending'};

export interface WorkspaceHeading {
  logo: WorkspaceLogo;
  /** 큰 제목. 이름이 오기 전에는 빈 문자열이다(대체 낱말을 세우지 않는다). */
  title: string;
  /** 로고와 제목을 한 번에 말하는 이름. 언제나 워크스페이스 범위다. */
  accessibilityLabel: string;
}

/**
 * 서버가 준 워크스페이스 아바타 content 경로만 통과시킨다 — 코어
 * `fetchWorkspaceAvatar` 와 같은 모양 검사. 임의 주소에 베어러를 싣지 않는다.
 */
export function isWorkspaceAvatarPath(path: string): boolean {
  return /^\/v1\/workspaces\/[^/]+\/avatar\/content(\?|$)/.test(path);
}

export function workspaceHeading(query: WorkspaceIdentityState): WorkspaceHeading {
  const name = query.name?.trim() ?? '';
  if (name === '' && query.isPending) {
    return {
      logo: {kind: 'pending'},
      title: '',
      accessibilityLabel: '워크스페이스 불러오는 중',
    };
  }
  const avatar = query.avatarUrl;
  const logo: WorkspaceLogo =
    avatar !== undefined && isWorkspaceAvatarPath(avatar)
      ? {kind: 'avatar', path: avatar}
      : {kind: 'brand'};
  if (name === '') {
    // 실패·빈 이름: 사람의 이름을 빌리지 않고 일반 낱말로 선다(웹과 같은 판정).
    return {logo, title: '워크스페이스', accessibilityLabel: '워크스페이스'};
  }
  return {logo, title: name, accessibilityLabel: `워크스페이스 ${name}`};
}
