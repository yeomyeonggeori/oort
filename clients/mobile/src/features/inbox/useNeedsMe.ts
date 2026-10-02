import {needsMe, type NeedsMe} from '@momo/core/features/inbox/needsMe';
import type {FeedItem} from '@momo/core/features/inbox/model';
import {isSurfaceProvided} from '@momo/core/features/capabilities/serverSurfaces';
import {composedUnreadCount} from '@momo/core/features/readState/model';
import type {ReadState} from '@momo/core/lib/api';
import {useMemo} from 'react';

import {useSession} from '../../session/useSession';
import {useReadStates} from '../workspace/queries';
import {useMentionCount, useNeedsAction} from './useInbox';

// =============================================================================
// 「나에게 필요한 일」 수의 폰 쪽 입구 (#3342, 사이드바·알림 시안 §1.2).
//
// 정의와 중복 제거는 core `needsMe`(#3337)가 갖는다 — 웹 레일·인박스·독 배지가
// 읽는 바로 그 함수다. 여기는 폰의 원천을 그 입력으로 옮기는 일만 한다. 화면마다
// 자기 합을 갖는 순간 탭은 3, 인박스 필터는 4를 말하기 시작한다.
//
// 폰에는 로컬 터미널 칸이 없다(ADR-0190 D1: PTY는 데스크탑 프로세스). 그래서
// `waitingPaneIds` 는 언제나 비고, 합은 **결정할 수 있는 대기 승인 + 안 읽은 멘션**
// 둘이다. 승인은 인박스 「결정 대기」 행이 결정 컨트롤을 세우는 규칙과 같은 것만
// 센다(대기 중이고 승인 id가 있다) — 세었는데 열어 보니 누를 것이 없는 수는 거짓이다.
//
// 앱 아이콘 배지는 이 수가 **아니다**. 그쪽은 서버가 푸시에 싣는 안 읽음 합이고(ADR-
// 0109, `push/appBadge.ts`), 시안 §7도 그것을 그대로 둔다.
// =============================================================================

/**
 * 순수 변환: 폰의 원천 → core 입력. 훅 밖에 있어 렌더 없이 못박을 수 있다.
 *
 * 로컬 칸은 일부러 인자에 없다 — 폰에는 없는 것을 「0개」로 넘기는 형태조차
 * 만들지 않는다.
 */
export function needsMeFrom(sources: {
  approvalItems: readonly FeedItem[];
  unreadMentions: number;
}): NeedsMe {
  const decidableApprovalIds: string[] = [];
  for (const item of sources.approvalItems) {
    if (item.kind === 'approval' && item.pending && item.approvalId !== undefined) {
      decidableApprovalIds.push(item.approvalId);
    }
  }
  return needsMe({
    decidableApprovalIds,
    waitingPaneIds: [],
    unreadMentions: sources.unreadMentions,
  });
}

/**
 * 홈 탭의 점: 안 읽은 글이 어딘가에 있는가. 수가 아니라 있다/없다다 — 수는 인박스
 * 알약이 말하는 「내가 해야 할 일」이고, 홈 점은 「읽을 것이 있다」 한 가지만 말한다.
 *
 * 사이드바 줄과 **같은 수**(`composedUnreadCount`)로 센다. 서버 합(`unreadCount`)으로
 * 세면 데스크탑에서 「여기부터 안 읽음」을 건 방이 줄에는 안 읽음으로 보이는데 점은
 * 꺼져 있게 된다(ADR-0178 D3).
 */
export function hasUnread(readStates: readonly ReadState[]): boolean {
  return readStates.some(state => composedUnreadCount(state) > 0);
}

export interface PhoneNeedsMe extends NeedsMe {
  /** 홈 탭의 안 읽음 점. */
  homeUnread: boolean;
}

export function usePhoneNeedsMe(): PhoneNeedsMe {
  const {workspaceId} = useSession();
  // 승인 원장이 없는 서버에서는 요청 자체를 만들지 않는다: 404를 0으로 세는 것은
  // 「결정할 것이 없다」를 지어내는 일이다. 인박스 「결정 대기」 탭과 같은 쿼리 키라
  // 두 자리가 한 번만 묻는다.
  const needsAction = useNeedsAction(isSurfaceProvided('approvals'));
  const unreadMentions = useMentionCount();
  const readStates = useReadStates(workspaceId);
  const homeUnread = hasUnread(readStates.data ?? []);
  return useMemo(
    () => ({
      ...needsMeFrom({approvalItems: needsAction.items, unreadMentions}),
      homeUnread,
    }),
    [needsAction.items, unreadMentions, homeUnread],
  );
}
