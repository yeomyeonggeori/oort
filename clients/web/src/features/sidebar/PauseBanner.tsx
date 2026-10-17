import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RosterMember } from "@momo/core/lib/api";
import {
  pauseBanner,
  pauseBannerElapsed,
  type PauseBannerKind,
} from "@momo/core/features/presence/pauseBanner";
import { PRESENCE_WRITE_FAILED } from "@momo/core/features/presence/model";
import {
  fetchNotificationRules,
  NOTIFICATION_PAUSE_SAVE_FAILED,
  patchNotificationRules,
  type NotificationRules,
} from "@momo/core/features/settings/notificationRules";
import { InlineBanner } from "@/features/common/States";
import { notificationRulesQueryKey } from "@/features/settings/notificationRulesKey";
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
// 카드의 **형제**다. 디자인 시스템의 `InlineBanner`(neutral) 문법을 그대로 쓴다.
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
// 웹의 질의 클라이언트는 포커스 재조회가 꺼져 있다(`app/queryClient.ts`) — 그래서 여기서 직접 건다.
// =============================================================================

const MINUTE_MS = 60_000;

/** 분 단위로 틱하는 지금. 이 줄 하나가 쥔 타이머다(줄이 없어도 돈다 — 있다가 없어졌다 다시 서는 줄이라서). */
function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

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
  const now = useMinuteNow();
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
    now
  );
  const elapsed = pauseBannerElapsed(banner, now);

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

  // 줄이 기대는 기한이 지났다 — 서버가 뭐라고 하는지 묻는다. 서버가 아직 켜져 있다고 답하면 줄은
  // 남고, 분 틱(`now`)이 돌 때마다 다시 묻는다. 서버 답이 줄을 지운다.
  useEffect(() => {
    if (elapsed) refresh();
  }, [elapsed, now, refresh]);

  // 실패 문장은 **누른 줄에만** 붙는다. 줄이 사라졌다 다시 서면 옛 실패가 새 줄에 남지 않는다.
  const [attempted, setAttempted] = useState<PauseBannerKind | null>(null);
  const kind = banner?.kind ?? null;
  useEffect(() => {
    if (attempted !== null && kind !== attempted) setAttempted(null);
  }, [attempted, kind]);

  if (banner === null) return null;

  const busy = banner.kind === "paused" ? resume.isPending : release.isPending;
  const failed =
    attempted === banner.kind &&
    (banner.kind === "paused" ? resume.isError : release.isError);
  const failure = failed
    ? banner.kind === "paused"
      ? NOTIFICATION_PAUSE_SAVE_FAILED
      : PRESENCE_WRITE_FAILED
    : null;

  const press = () => {
    if (busy) return;
    setAttempted(banner.kind);
    if (banner.kind === "paused") resume.mutate();
    else release.mutate({ status: "auto" });
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
      <InlineBanner
        tone="neutral"
        separator={false}
        testId="pause-banner-line"
        // 프로필 카드의 아바타 왼쪽 끝에 글자 첫 줄이 맞도록 안쪽 여백을 한 칸 줄인다.
        className="px-3"
        message={
          // 사이드바 폭에서는 「알림 일시 중지 중 · 오후 10:30까지」가 한 줄에 못 든다. 우연히 끊기면 가운뎃점이
          // 줄 끝에 매달리므로 제목과 기한을 의도한 두 줄로 쌓는다(문장 전체는 묶음의 접근 이름이 갖는다).
          // 방해 금지 줄처럼 제목만 있는 줄이 접히면 두 줄이 비슷한 길이로 접힌다(`text-balance`).
          <span className="block text-balance">
            <span className="block font-medium" data-testid="pause-banner-title">
              {banner.title}
            </span>
            {banner.detail === undefined ? null : (
              <span className="block text-ink-muted" data-testid="pause-banner-detail">
                {banner.detail}
              </span>
            )}
          </span>
        }
        actionLabel={banner.action}
        actionBusy={busy}
        onAction={press}
      />
      {failure === null ? null : (
        <InlineBanner
          tone="error"
          separator={false}
          testId="pause-banner-failure"
          message={failure}
        />
      )}
    </div>
  );
}
