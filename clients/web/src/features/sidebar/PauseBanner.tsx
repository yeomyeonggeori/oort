import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RosterMember } from "@momo/core/lib/api";
import {
  pauseBanner,
  type PauseBannerKind,
} from "@momo/core/features/presence/pauseBanner";
import { PAUSE_UNTIL_OFFLINE_REASON } from "@momo/core/features/presence/pauseUntil";
import { PRESENCE_WRITE_FAILED } from "@momo/core/features/presence/model";
import {
  fetchNotificationRules,
  NOTIFICATION_PAUSE_SAVE_FAILED,
  patchNotificationRules,
  type NotificationRules,
} from "@momo/core/features/settings/notificationRules";
import { Button } from "@/design/ui/button";
import { useOffline } from "@/features/common/useOffline";
import { notificationRulesQueryKey } from "@/features/settings/notificationRulesKey";
import { useRecheckWhenElapsed } from "@/features/settings/useRecheckWhenElapsed";
import { useSelfPresenceWrite } from "./useSelfPresenceWrite";

// =============================================================================
// 멈춤이 보인다 — 사이드바 내 이름 아래의 한 줄 (ADR-0204 D3, #3923).
//
// 성재 계정은 방해 금지를 고른 뒤 15일 동안 기한 없는 알림 일시 중지 상태였는데, 그 사실은
// 폰 프로필 시트와 설정 › 알림 안에만 있어서 어디에도 보이지 않았다. 알림이 오지 않는 이유를 찾을
// 때 눈이 가는 자리인 사이드바의 프로필 줄 아래에 한 줄을 둔다:
//
//   * 알림 일시 중지 중 — 「알림 일시 중지 중 · 오후 9:30까지」 + 「다시 켜기」
//   * 일시 중지는 꺼졌는데 상태가 아직 방해 금지 — 「상태는 아직 방해 금지예요」 + 「풀기」
//   * 아니면 줄이 없다(자리도 없다).
//
// 어느 줄이 서는지와 문장은 코어(`presence/pauseBanner.ts`)가 정한다. 폰 인박스가 같은 것을 쓴다.
// 프로필 카드는 전체가 하나의 버튼이라 그 안에 단추를 둘 수 없다(중첩된 상호작용) — 그래서 이 줄은
// 카드의 **형제**다.
//
// ## 그릇은 사이드바의 「지금 카드」와 같은 문법이다 (design-review M4)
//
// 처음에는 `InlineBanner`(neutral)를 그대로 썼는데, 그 상자는 반경 0의 평평한 띠이고 `bg-surface-hover`
// 를 입는다. 둥근 사이드바 안에서 혼자 각진 띠였고, 사이드바 범위에서는 호버 채움(`--band-fill`)이라
// 프로필 카드를 호버했을 때의 색과 같았다 — 정적인 그릇이 상호작용 상태 토큰을 입은 것이다. 그래서
// 사이드바가 흰 면을 쓰는 방식(`glass band-surface` + rest 그림자, 검색 입구·지금 카드와 같다)으로 짓고,
// 글자는 프로필 줄과 같은 역할로 맞춘다(제목은 이름과 같은 `text-label`, 기한은 둘째 줄과 같은
// `text-meta` 약한 글자). 실패·오프라인 이유는 그 흰 면 **안**에 서서 단추 바로 아래에서 말한다.
//
// ## 쓰기는 새 길이 없다
//
// 「다시 켜기」는 설정 › 알림의 스위치와 같은 쓰기(`PATCH notification-rules {dnd:false}`)이고 방해
// 금지 상태는 건드리지 않는다 — 그러면 아래 둘째 줄이 서는 것이 정상이다(ADR-0204 D2). 「풀기」는
// 프로필 메뉴와 같은 훅(`useSelfPresenceWrite`)의 `auto` 쓰기이고, 그 뒤 규칙 재조회는 그 훅이 한다.
//
// ## 기한이 지나도 이 줄이 스스로 내려가지 않는다
//
// 서버가 만료를 판정한다(푸시 판정 시점 비교). 브라우저 시계로 줄을 내리면 서버와 어긋난 채로 「멈춰
// 있지 않다」고 말한다. 대신 **다시 묻는다**: 창이 다시 보이거나 포커스를 받을 때, 그리고 줄이 기대는
// 기한이 지난 동안은 분 틱마다 규칙과 명부를 다시 읽는다. 줄은 서버의 새 답이 올 때 사라진다. 서버가
// 아직 켜져 있다고 답하면(두 시계의 차이) 줄은 남고 다음 틱에 다시 묻는다.
// 웹의 질의 클라이언트는 포커스 재조회가 꺼져 있다(`app/queryClient.ts`) — 그래서 창 포커스·보임은
// 여기서 직접 걸고, 기한이 지난 뒤의 다시 묻기는 설정·프로필 카드와 같은 훅(`useRecheckWhenElapsed`)이 한다.
//
// ## 실패 이유는 낙관 칠하기와 독립으로 붙는다 (design-review H1)
//
// 「다시 켜기」「풀기」를 누르면 낙관 칠하기가 서버 답보다 먼저 줄을 바꾼다(줄이 사라지거나 방해 금지
// 줄로 바뀐다). 서버가 실패하면 되돌려 줄이 다시 서는데, 이때 「누른 줄」 표식이 줄 모양이 바뀐 순간에 이미
// 지워져 있으면 이유 문장이 한 번도 뜨지 않는다(줄이 사라졌다가 이유 없이 되돌아온다 — 이 이슈가 막으려던
// 것과 같은 모양이다). 그래서 실패는 **쓰기의 `onError`** 가 알리고, 어느 줄(종류·기한)에 대한 실패인지와
// 함께 들고 있다. 다른 줄이 서 있을 때는 붙지 않는다.
//
// ## 같은 자리에서 반대 행동이 올라오지 않게 (design-review M1)
//
// 「다시 켜기」를 누르면 같은 자리의 단추가 낙관 칠하기로 곧바로 「풀기」가 된다. 더블클릭의 둘째 누름이
// 원치 않은 방해 금지 해제를 보내지 않도록, 쓰기가 **어느 것이든** 날고 있는 동안은 누르지 않고, 방금 누른
// 줄과 다른 종류의 단추는 잠깐(`FLIP_GUARD_MS`) 받지 않는다. 같은 줄의 다시 시도는 막지 않는다.
//
// ## 끊겨 있으면 단추 자리에 이유를 말한다
//
// 끊긴 채 누른 뮤테이션은 낙관값만 칠하고 멈췄다가 재연결 뒤에 나간다 — 줄은 사라졌는데 서버는 아직
// 모른다. 그래서 끊긴 동안은 단추를 거두고 그 자리에 이유를 말한다(승인 컨트롤이 오프라인에서 하는 것과
// 같다: 버튼을 남겨 두지도, 말없이 치우지도 않는다).
// =============================================================================

/** 방금 누른 줄과 **다른 종류**의 단추를 받지 않는 시간. 같은 줄의 다시 시도는 막지 않는다. */
const FLIP_GUARD_MS = 1500;

/** 일시 중지만 끈 뒤의 낙관 칠하기: 꺼지면 기한도 사라진다(서버가 지운다). */
function paintResumed(rules: NotificationRules): NotificationRules {
  const next: NotificationRules = { ...rules, dnd: false };
  delete next.dndUntilMs;
  return next;
}

export function PauseBanner({
  workspaceId,
  selfMemberId,
  selfMember,
}: {
  workspaceId: string;
  selfMemberId: string;
  /** 명부의 내 행. 아직 못 읽었으면 없다. */
  selfMember: RosterMember | null | undefined;
}) {
  const client = useQueryClient();
  const offline = useOffline();
  const rulesKey = notificationRulesQueryKey(workspaceId);

  const rules = useQuery({
    queryKey: rulesKey,
    queryFn: () => fetchNotificationRules(workspaceId),
    retry: false,
  });
  const resume = useMutation({
    mutationFn: () => patchNotificationRules(workspaceId, { dnd: false }),
    onMutate: async () => {
      await client.cancelQueries({ queryKey: rulesKey });
      const previous = client.getQueryData<NotificationRules>(rulesKey);
      if (previous) client.setQueryData<NotificationRules>(rulesKey, paintResumed(previous));
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) client.setQueryData(rulesKey, context.previous);
    },
    onSuccess: (saved) => client.setQueryData(rulesKey, saved),
  });
  const release = useSelfPresenceWrite(workspaceId, selfMemberId);

  const data = rules.data;
  const banner = pauseBanner(
    {
      rulesReady: data !== undefined,
      paused: data?.dnd ?? false,
      untilMs: data?.dnd ? data.dndUntilMs : undefined,
      declared: selfMember?.presenceStatus,
      declaredUntilMs: selfMember?.dndUntilMs,
    },
    Date.now()
  );

  // 줄이 기대는 기한이 지나면 서버에 다시 묻는다(스스로 내려가지 않는다). 설정·프로필 카드와 같은 훅이다.
  useRecheckWhenElapsed(workspaceId, banner?.untilMs);

  // 서버에 다시 묻는다. 규칙과 명부 둘 다다 — 일시 중지 줄은 규칙, 방해 금지 줄은 명부에 기댄다.
  const refresh = useCallback(() => {
    void client.invalidateQueries({ queryKey: notificationRulesQueryKey(workspaceId) });
    void client.invalidateQueries({ queryKey: ["roster", workspaceId] });
  }, [client, workspaceId]);

  // 창이 다시 보이거나 포커스를 받으면 다시 묻는다(질의 클라이언트의 포커스 재조회는 꺼져 있다).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // 실패는 쓰기의 `onError` 가 알린다 — 낙관 칠하기가 줄 모양을 바꾼 것과 독립이다(위 「실패 이유」).
  // 어느 줄(종류·기한)에 대한 실패인지 함께 들고 있어, 다른 줄이 서 있을 때는 붙지 않는다. 줄이 사라졌다
  // 다시 서도 기한이 다르면 옛 실패가 새 줄에 남지 않는다.
  const [failure, setFailure] = useState<{
    kind: PauseBannerKind;
    untilMs?: number;
  } | null>(null);
  const lastPress = useRef<{ kind: PauseBannerKind; at: number } | null>(null);
  // 어느 쓰기든 날고 있으면 단추를 받지 않는다(더블클릭의 둘째 누름이 반대 행동이 되지 않게).
  const pending = resume.isPending || release.isPending;

  if (banner === null) return null;

  const failed =
    failure !== null &&
    failure.kind === banner.kind &&
    failure.untilMs === banner.untilMs;
  const failureText = failed
    ? banner.kind === "paused"
      ? NOTIFICATION_PAUSE_SAVE_FAILED
      : PRESENCE_WRITE_FAILED
    : null;

  const press = () => {
    if (pending || offline) return;
    const previous = lastPress.current;
    const now = Date.now();
    // 방금 다른 종류의 줄을 누른 직후에 같은 자리에 올라온 단추는 더블클릭의 둘째 누름일 수 있다.
    if (previous !== null && previous.kind !== banner.kind && now - previous.at < FLIP_GUARD_MS) {
      return;
    }
    lastPress.current = { kind: banner.kind, at: now };
    setFailure(null);
    const onError = () => setFailure({ kind: banner.kind, untilMs: banner.untilMs });
    if (banner.kind === "paused") resume.mutate(undefined, { onError });
    else release.mutate({ status: "auto" }, { onError });
  };

  return (
    // 묶음의 이름이 문장 전체(`banner.label`)다: 단추로 곧바로 Tab 해 와도 무엇을 다시 켜는지 읽힌다.
    <div
      role="group"
      aria-label={banner.label}
      data-testid="pause-banner"
      data-kind={banner.kind}
      className="pt-2"
    >
      <div className="glass band-surface flex flex-col gap-1 rounded-lg px-3 py-2 text-ink shadow-sm">
        <div className="flex items-center gap-2" data-testid="pause-banner-line">
          {/* 사이드바 폭에서는 「알림 일시 중지 중 · 오후 10:30까지」가 한 줄에 못 든다. 우연히 끊기면 가운뎃점이
              줄 끝에 매달리므로 제목과 기한을 의도한 두 줄로 쌓는다(문장 전체는 묶음의 접근 이름이 갖는다).
              어절에서 끊고(`break-keep`), 접히면 두 줄이 비슷한 길이로 접힌다(`text-balance`). */}
          <span className="flex min-w-0 flex-1 flex-col break-keep text-balance">
            <span className="text-label font-medium" data-testid="pause-banner-title">
              {banner.title}
            </span>
            {banner.detail === undefined ? null : (
              <span className="text-meta text-ink-muted" data-testid="pause-banner-detail">
                {banner.detail}
              </span>
            )}
          </span>
          {/* 끊겨 있으면 단추를 거두고 아래 줄이 이유를 말한다. */}
          {offline ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              aria-busy={pending || undefined}
              data-testid="pause-banner-action"
              onClick={press}
            >
              {banner.action}
            </Button>
          )}
        </div>
        {offline ? (
          <p
            role="status"
            className="break-keep text-balance text-meta text-ink-muted"
            data-testid="pause-banner-offline"
          >
            {PAUSE_UNTIL_OFFLINE_REASON}
          </p>
        ) : failureText === null ? null : (
          <p
            role="alert"
            className="break-keep text-balance text-meta text-danger"
            data-testid="pause-banner-failure"
          >
            {failureText}
          </p>
        )}
      </div>
    </div>
  );
}
